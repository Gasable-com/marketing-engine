import { withTenant, type Tx } from '../../db/client.js';
import { env } from '../../env.js';
import { enqueue } from '../../jobs/queue.js';
import { emit } from '../../spine/events/index.js';
import { ask, bridgeConfigured, reserveClaudeCall } from './claude.js';
import { DiscoveryError, PermanentError, UsageLimitError } from './errors.js';
import { getFinder, type FinderQuery } from './finder/index.js';
import { Identified, Personas, identifyPrompt, personasPrompt, type Persona } from './prompts.js';
import { namesAPlace, placeWords } from './search/country.js';
import { runSearch, runTriage, searchNeeds } from './search/stages.js';
import { runReadExtract } from './extract/stage.js';

/**
 * Discovery jobs: an operator's search for a product, on one side (suppliers
 * that sell it, or buyers that would use it), across one or more countries.
 *
 * A job first plans, once: PLAN_STAGES identify the product and the personas
 * to search for. Then it runs one task per country through TASK_STAGES. Each
 * stage is named, records itself when it finishes so a retry carries on after
 * it, and may wait out a Claude usage limit instead of failing.
 */

export const DISCOVERY_PLAN_JOB = 'discovery.plan';
export const DISCOVERY_TASK_JOB = 'discovery.task';

/** pg-boss retries per plan or task before it is failed. */
export const TASK_RETRY_LIMIT = 3;

/**
 * How long one delivery may run. Above the worst case of every stage's caps,
 * so pg-boss never hands a live job to a second worker; a delivery whose
 * worker died is claimable again once this has passed.
 */
export const RUN_EXPIRY_SECONDS = 7200;

/** When a usage limit says nothing about its reset. */
const DEFAULT_DEFER_SECONDS = 3600;

export const DEFAULT_RESULT_LIMIT = 50;
export const MAX_RESULT_LIMIT = 200;
export const MAX_COUNTRIES = 10;
export const MAX_SOURCE_ROW = 5000;

export type Side = 'suppliers' | 'buyers';

export type JobRow = {
  id: string;
  tenant_id: string;
  product: string;
  category: string | null;
  side: Side;
  countries: string[];
  terms: string[];
  result_limit: number;
  status: 'planning' | 'running' | 'done' | 'failed';
  counts: Counts;
  identified: Identified | null;
  /** The operator confirmed the product before the search began, e.g. by picking a "did you mean". */
  product_confirmed: boolean;
  stages_done: string[];
  error: string | null;
  attempts: number;
  deferrals: number;
  source_row: string | null;
  created_at: Date;
  started_at: Date | null;
  deferred_until: Date | null;
  finished_at: Date | null;
};

export type TaskRow = {
  id: string;
  tenant_id: string;
  job_id: string;
  country: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  stage: string | null;
  counts: Counts;
  error: string | null;
  attempts: number;
  stages_done: string[];
  deferrals: number;
  created_at: Date;
  started_at: Date | null;
  deferred_until: Date | null;
  finished_at: Date | null;
};

export type PersonaRow = {
  id: string;
  tenant_id: string;
  job_id: string;
  position: number;
  name: string;
  description: string;
  roles: string[];
  sectors: string[];
  search_terms: string[];
  places_terms: string[];
  signals: string[];
  created_at: Date;
};

/** What a stage did, by name. A task's counts merge its stages'; a job's sum its tasks'. */
export type Counts = Record<string, number>;

export type PlanJob = { tenantId: string; jobId: string };
export type TaskJob = { tenantId: string; taskId: string };

export type JobInput = {
  tenantId: string;
  product: string;
  category?: string | undefined;
  countries: string[];
  resultLimit?: number | undefined;
  side?: Side | undefined;
  /** The row the operator pasted, when the search started from one. */
  row?: string | undefined;
  /**
   * The identification the operator accepted before searching (from
   * identifyProduct): planning starts from it instead of asking again.
   */
  identified?: Identified | undefined;
  /** The operator confirmed `product` is what they mean, e.g. a "did you mean" they picked. */
  confirmed?: boolean | undefined;
};

/**
 * A named step of a job (plan stages) or of a task (task stages). `needs`
 * says whether its provider is configured; a stage without one is skipped and
 * the skip is counted. Each stage opens its own transactions, so one that
 * waits on the network holds none open while it waits.
 */
type PlanStage = { name: string; needs?: () => boolean; run: (job: JobRow) => Promise<Counts> };
type TaskStage = {
  name: string;
  needs?: () => boolean;
  run: (job: JobRow, task: TaskRow) => Promise<Counts>;
};

// ---------------------------------------------------------------------------
// Creating a job
// ---------------------------------------------------------------------------

/**
 * Create a job. With the Claude bridge configured it starts `planning` and
 * its tasks are created when planning finishes; without it the job and one
 * queued task per country are created at once, as before planning existed.
 * On the caller's transaction either way.
 */
export async function createJob(
  tx: Tx,
  input: JobInput,
): Promise<{ job: JobRow; tasks: TaskRow[] }> {
  const { product, category, countries, resultLimit, side, row } = validate(input);
  const plans = bridgeConfigured();
  if (side === 'buyers' && !plans) {
    throw new DiscoveryError(
      'buyers_need_planning',
      400,
      'a buyers search needs the Claude bridge to work out who would buy the product',
    );
  }

  // An identification the operator already accepted is the plan's first stage, done.
  const identified = plans && input.identified ? input.identified : null;
  const terms = identified && side === 'suppliers' ? identified.aliases : [];
  const [job] = await tx<JobRow[]>`
    insert into discovery_jobs
      (tenant_id, product, category, side, countries, result_limit, source_row, status,
       identified, terms, stages_done, product_confirmed)
    values (${input.tenantId}, ${product}, ${category}, ${side}, ${countries}, ${resultLimit},
            ${row}, ${plans ? 'planning' : 'running'},
            ${identified ? tx.json(identified as never) : null}, ${terms},
            ${identified ? ['identify'] : []}, ${Boolean(identified) || input.confirmed === true})
    returning *
  `;
  if (!job) throw new Error('createJob wrote no job');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'discovery.job.created',
    subjectType: 'discovery_job',
    subjectId: job.id,
    payload: { jobId: job.id, product, countries },
  });

  if (plans) {
    await enqueuePlan(tx, job);
    return { job, tasks: [] };
  }
  return { job, tasks: await startTasks(tx, job) };
}

function validate(input: JobInput) {
  const product = input.product.trim();
  if (product.length < 2 || product.length > 200) {
    throw new DiscoveryError('invalid_product', 400, 'product must be 2 to 200 characters');
  }

  const category = input.category?.trim() || null;
  if (category && category.length > 200) {
    throw new DiscoveryError('invalid_category', 400, 'category must be at most 200 characters');
  }

  const countries = input.countries.map((c) => c.trim().toUpperCase());
  if (countries.length < 1 || countries.length > MAX_COUNTRIES) {
    throw new DiscoveryError('invalid_countries', 400, `between 1 and ${MAX_COUNTRIES} countries`);
  }
  const bad = countries.filter((c) => !/^[A-Z]{2}$/.test(c));
  if (bad.length) {
    throw new DiscoveryError('invalid_countries', 400, `not ISO 3166-1 alpha-2: ${bad.join(', ')}`);
  }
  if (new Set(countries).size !== countries.length) {
    throw new DiscoveryError('invalid_countries', 400, 'each country once');
  }

  const resultLimit = input.resultLimit ?? DEFAULT_RESULT_LIMIT;
  if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > MAX_RESULT_LIMIT) {
    throw new DiscoveryError('invalid_result_limit', 400, `resultLimit must be 1 to ${MAX_RESULT_LIMIT}`);
  }

  const side = input.side ?? 'suppliers';
  if (side !== 'suppliers' && side !== 'buyers') {
    throw new DiscoveryError('invalid_side', 400, 'side is suppliers or buyers');
  }

  const row = input.row?.trim() || null;
  if (row && row.length > MAX_SOURCE_ROW) {
    throw new DiscoveryError('invalid_row', 400, `the pasted row must be at most ${MAX_SOURCE_ROW} characters`);
  }

  return { product, category, countries, resultLimit, side, row };
}

async function enqueuePlan(tx: Tx, job: JobRow, startAfterSeconds?: number): Promise<void> {
  await enqueue(
    tx,
    DISCOVERY_PLAN_JOB,
    { tenantId: job.tenant_id, jobId: job.id } satisfies PlanJob,
    {
      singletonKey: job.id,
      retryLimit: TASK_RETRY_LIMIT,
      retryBackoff: true,
      expireInSeconds: RUN_EXPIRY_SECONDS,
      ...(startAfterSeconds !== undefined ? { startAfterSeconds } : {}),
    },
  );
}

async function enqueueTask(tx: Tx, task: TaskRow, startAfterSeconds?: number): Promise<void> {
  await enqueue(
    tx,
    DISCOVERY_TASK_JOB,
    { tenantId: task.tenant_id, taskId: task.id } satisfies TaskJob,
    {
      singletonKey: task.id,
      retryLimit: TASK_RETRY_LIMIT,
      retryBackoff: true,
      expireInSeconds: RUN_EXPIRY_SECONDS,
      ...(startAfterSeconds !== undefined ? { startAfterSeconds } : {}),
    },
  );
}

/** One queued task per country, each on the queue. */
async function startTasks(tx: Tx, job: JobRow): Promise<TaskRow[]> {
  const tasks: TaskRow[] = [];
  for (const country of job.countries) {
    const [task] = await tx<TaskRow[]>`
      insert into discovery_tasks (tenant_id, job_id, country, status)
      values (${job.tenant_id}, ${job.id}, ${country}, 'queued')
      returning *
    `;
    if (!task) throw new Error('startTasks wrote no task');
    tasks.push(task);
    await enqueueTask(tx, task);
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Planning: what the product is, and who to search for
// ---------------------------------------------------------------------------

const identify: PlanStage = {
  name: 'identify',
  needs: bridgeConfigured,
  async run(job) {
    if (!(await reserveClaudeCall(job.tenant_id, job.id))) throw new PermanentError('claude budget spent');
    const raw = await ask('identify', {
      system: identifyPrompt.system,
      schema: identifyPrompt.schema,
      input: JSON.stringify({
        product: job.product,
        category: job.category,
        pastedRow: job.source_row,
        ...(job.product_confirmed ? { confirmed: true } : {}),
      }),
    });
    const parsed = Identified.safeParse(raw);
    if (!parsed.success) throw new Error('claude bridge: identify answer out of shape');
    const identified = parsed.data;
    if (identified.notIdentified) throw new PermanentError('the product could not be identified');

    // For a suppliers search the product's own names are what to look for. A
    // buyers search looks for kinds of company, never the product's sellers.
    const terms = job.side === 'suppliers' ? identified.aliases : [];
    await withTenant(job.tenant_id, (tx) => tx`
      update discovery_jobs
      set identified = ${tx.json(identified as never)}, terms = ${terms}
      where id = ${job.id}
    `);
    return { aliases: identified.aliases.length };
  },
};

const personas: PlanStage = {
  name: 'personas',
  needs: bridgeConfigured,
  async run(job) {
    if (!job.identified) throw new Error('personas: the job has no identified product');
    if (!(await reserveClaudeCall(job.tenant_id, job.id))) throw new PermanentError('claude budget spent');
    const raw = await ask('personas', {
      system: personasPrompt.system,
      schema: personasPrompt.schema,
      input: JSON.stringify({ side: job.side, product: job.identified }),
    });
    const parsed = Personas.safeParse(raw);
    if (!parsed.success) throw new Error('claude bridge: personas answer out of shape');

    // The country is added when searching, from its discovery.country row.
    const places = await placeWords(job.tenant_id);
    const clean = (terms: string[]) => [...new Set(terms.filter((t) => !namesAPlace(t, places)))];
    const list: Persona[] = parsed.data.personas.map((p) => ({
      ...p,
      searchTerms: clean(p.searchTerms),
      placesTerms: clean(p.placesTerms),
    }));

    await withTenant(job.tenant_id, async (tx) => {
      await tx`delete from discovery_personas where job_id = ${job.id}`;
      for (const [position, p] of list.entries()) {
        await tx`
          insert into discovery_personas
            (tenant_id, job_id, position, name, description, roles, sectors,
             search_terms, places_terms, signals)
          values (${job.tenant_id}, ${job.id}, ${position}, ${p.name}, ${p.description},
                  ${p.roles}, ${p.sectors}, ${p.searchTerms}, ${p.placesTerms}, ${p.signals})
        `;
      }
    });
    return { personas: list.length };
  },
};

/** Run once per job, in order, before any task. */
const PLAN_STAGES: readonly PlanStage[] = [identify, personas];

type Outcome = 'done' | 'deferred' | 'failed' | 'skipped';

/**
 * `discovery.plan`: run the job's plan stages, then create and queue its
 * tasks. Throws on a retryable failure so pg-boss retries; on the final
 * attempt, or on a permanent error, the job fails with the reason instead.
 */
export async function runPlan(data: PlanJob, opts: { finalAttempt?: boolean } = {}): Promise<Outcome> {
  const claimed = await withTenant(data.tenantId, async (tx) => {
    const [job] = await tx<JobRow[]>`
      update discovery_jobs
      set started_at = now(), attempts = attempts + 1, deferred_until = null
      where id = ${data.jobId} and status = 'planning'
        and (started_at is null or started_at < now() - make_interval(secs => ${RUN_EXPIRY_SECONDS}))
      returning *
    `;
    return job ?? null;
  });
  if (!claimed) return 'skipped';

  for (const stage of PLAN_STAGES) {
    const job = await readJob(data.tenantId, data.jobId);
    if (!job || job.status !== 'planning') return 'skipped';
    if (job.stages_done.includes(stage.name)) continue;

    if (stage.needs && !stage.needs()) {
      await recordJobStage(job, stage.name, { [`skipped_${stage.name}`]: 1 });
      continue;
    }

    try {
      const counts = await stage.run(job);
      await recordJobStage(job, stage.name, counts);
    } catch (err) {
      if (err instanceof UsageLimitError) return deferJob(job, err.resetsAt);
      if (err instanceof PermanentError || opts.finalAttempt) {
        await failPlan(job, (err as Error).message);
        if (err instanceof PermanentError) return 'failed';
        throw err;
      }
      // Let go of the claim, so the retry pg-boss is about to make can take it.
      await withTenant(data.tenantId, (tx) => tx`
        update discovery_jobs set started_at = null where id = ${job.id} and status = 'planning'
      `);
      throw err;
    }
  }

  // Planned: the job runs, with its tasks created and queued in the same breath.
  await withTenant(data.tenantId, async (tx) => {
    const [job] = await tx<JobRow[]>`
      update discovery_jobs set status = 'running'
      where id = ${data.jobId} and status = 'planning'
      returning *
    `;
    if (!job) return;
    await startTasks(tx, job);
    const names = await tx<{ name: string }[]>`
      select name from discovery_personas where job_id = ${job.id} order by position
    `;
    await emit(tx, {
      tenantId: job.tenant_id,
      type: 'discovery.job.planned',
      subjectType: 'discovery_job',
      subjectId: job.id,
      payload: { jobId: job.id, product: job.identified?.name ?? job.product, personas: names.map((n) => n.name) },
    });
  });
  return 'done';
}

/**
 * What the product is, asked before any search exists: the "did you mean"
 * step. Nothing is stored and no job is charged. Null without the bridge, and
 * the caller searches the product as typed.
 */
export async function identifyProduct(input: {
  product: string;
  category?: string | undefined;
  row?: string | undefined;
}): Promise<Identified | null> {
  if (!bridgeConfigured()) return null;
  const product = input.product.trim();
  if (product.length < 2 || product.length > 200) {
    throw new DiscoveryError('invalid_product', 400, 'product must be 2 to 200 characters');
  }
  const raw = await ask('identify', {
    system: identifyPrompt.system,
    schema: identifyPrompt.schema,
    input: JSON.stringify({
      product,
      category: input.category?.trim() || null,
      pastedRow: input.row?.trim() || null,
    }),
  });
  const parsed = Identified.safeParse(raw);
  if (!parsed.success) throw new Error('claude bridge: identify answer out of shape');
  return parsed.data;
}

async function readJob(tenantId: string, jobId: string): Promise<JobRow | undefined> {
  const [job] = await withTenant(tenantId, (tx) => tx<JobRow[]>`select * from discovery_jobs where id = ${jobId}`);
  return job;
}

async function recordJobStage(job: JobRow, name: string, counts: Counts): Promise<void> {
  await withTenant(job.tenant_id, (tx) => tx`
    update discovery_jobs
    set stages_done = array_append(stages_done, ${name}),
        counts = counts || ${tx.json(counts)}
    where id = ${job.id}
  `);
}

/** Wait out a usage limit: the job stays planning and comes back at the reset. */
async function deferJob(job: JobRow, resetsAt: Date | null): Promise<Outcome> {
  if (job.deferrals >= env().DISCOVERY_MAX_DEFERRALS) {
    await failPlan(job, 'usage limit not cleared');
    return 'failed';
  }
  const until = deferUntil(resetsAt);
  await withTenant(job.tenant_id, async (tx) => {
    await tx`
      update discovery_jobs
      set deferred_until = ${until}, deferrals = deferrals + 1,
          attempts = greatest(attempts - 1, 0), started_at = null
      where id = ${job.id}
    `;
    await enqueuePlan(tx, job, secondsUntil(until));
    await emit(tx, {
      tenantId: job.tenant_id,
      type: 'discovery.job.deferred',
      subjectType: 'discovery_job',
      subjectId: job.id,
      payload: { jobId: job.id, resetsAt: until.toISOString() },
    });
  });
  return 'deferred';
}

/** A job that could not plan has no tasks; it finishes failed with why. */
async function failPlan(job: JobRow, error: string): Promise<void> {
  await withTenant(job.tenant_id, async (tx) => {
    const [failed] = await tx<JobRow[]>`
      update discovery_jobs
      set status = 'failed', error = ${error}, finished_at = now(), deferred_until = null
      where id = ${job.id} and status = 'planning'
      returning *
    `;
    if (!failed) return;
    await emit(tx, {
      tenantId: failed.tenant_id,
      type: 'discovery.job.finished',
      subjectType: 'discovery_job',
      subjectId: failed.id,
      payload: { jobId: failed.id, status: 'failed', counts: failed.counts, error },
    });
  });
}

function deferUntil(resetsAt: Date | null): Date {
  const fallback = new Date(Date.now() + DEFAULT_DEFER_SECONDS * 1000);
  if (!resetsAt || resetsAt.getTime() <= Date.now()) return fallback;
  return resetsAt;
}

function secondsUntil(at: Date): number {
  return Math.max(0, Math.ceil((at.getTime() - Date.now()) / 1000));
}

// ---------------------------------------------------------------------------
// Tasks: one country each
// ---------------------------------------------------------------------------

/**
 * Rank a task's results in two tiers.
 *
 * Found: the companies this task found and saved (or found again with a
 * fresh profile), scored by persona fit and the share of the persona's
 * signals their checked evidence shows, plus profile quality and freshness.
 *
 * Pool: companies already in the pool that this task did not find, from the
 * `products` finder, always below the found ones. A suppliers search matches
 * the product's own names; a buyers search matches the personas' Maps
 * keywords (kinds of company), never the product, which would list sellers.
 *
 * The weights are constants until tuned against reviewed results; then they
 * move to rule rows.
 */
const FIT_WEIGHT = { strong: 0.6, weak: 0.3 } as const;
const SIGNALS_WEIGHT = 0.2;
const QUALITY_WEIGHT = { full: 0.1, thin: 0.05 } as const;
const FRESH_WEIGHT = 0.1;

type FoundRow = {
  company_id: string;
  persona_id: string | null;
  fit: 'strong' | 'weak' | null;
  evidence: { signal: number | null; claim: string; quote: string; url: string }[];
  quality: 'full' | 'thin' | null;
  age_days: number | null;
};

type ResultRow = {
  company_id: string;
  score: number;
  reasons: string[];
  tier: 'found' | 'pool';
  persona_id: string | null;
  fit: 'strong' | 'weak' | null;
  evidence: unknown[];
};

function freshness(ageDays: number | null): number {
  if (ageDays === null) return 0;
  if (ageDays <= 90) return 1;
  if (ageDays >= 365) return 0;
  return (365 - ageDays) / (365 - 90);
}

const rank: TaskStage = {
  name: 'rank',
  async run(job, task) {
    const personas = await withTenant(job.tenant_id, (tx) => tx<PersonaRow[]>`
      select * from discovery_personas where job_id = ${job.id} order by position
    `);
    const byId = new Map(personas.map((p) => [p.id, p]));

    // A company merged away since is ranked as its survivor; one now on the
    // marketplace, or merged further, is not ranked at all.
    const found = await withTenant(job.tenant_id, (tx) => tx<FoundRow[]>`
      select distinct on (s.id)
             s.id::text as company_id, d.persona_ids[1]::text as persona_id, d.fit, d.evidence,
             p.quality, extract(epoch from now() - p.profiled_at)::float8 / 86400 as age_days
      from discovery_candidates d
      join companies c on c.id = d.company_id
      join companies s on s.id = coalesce(c.merged_into, c.id)
      left join company_profiles p on p.company_id = s.id
      where d.task_id = ${task.id} and d.status = 'extracted'
        and s.merged_into is null and s.on_platform_ref is null
      order by s.id, (jsonb_array_length(d.evidence) > 0) desc, case d.fit when 'strong' then 0 else 1 end
    `);

    const foundRows: ResultRow[] = found.map((f) => {
      const persona = f.persona_id ? byId.get(f.persona_id) : undefined;
      const signals = new Set(f.evidence.map((e) => e.signal).filter((s): s is number => s !== null));
      const share = persona && persona.signals.length ? signals.size / persona.signals.length : 0;
      const fresh = freshness(f.age_days);
      const score =
        (f.fit ? FIT_WEIGHT[f.fit] : 0) +
        SIGNALS_WEIGHT * share +
        (f.quality ? QUALITY_WEIGHT[f.quality] : 0) +
        FRESH_WEIGHT * fresh;
      const reasons = [
        ...(persona ? [`persona: ${persona.name}`] : []),
        ...f.evidence.map((e) => `"${e.quote}" — ${e.url}`),
        ...(f.quality ? [`profile: ${f.quality}`] : []),
        ...(f.evidence.length === 0 && f.fit ? [`${f.fit} fit from search results`] : []),
        ...(fresh > 0 && f.age_days !== null ? [`profiled ${Math.max(0, Math.floor(f.age_days))} days ago`] : []),
      ];
      return { company_id: f.company_id, score, reasons, tier: 'found', persona_id: f.persona_id, fit: f.fit, evidence: f.evidence };
    });
    foundRows.sort((a, b) => b.score - a.score);
    const kept = foundRows.slice(0, job.result_limit);

    // The pool below what was found.
    let pool: ResultRow[] = [];
    const room = job.result_limit - kept.length;
    const terms =
      job.side === 'buyers' ? [...new Set(personas.flatMap((p) => p.places_terms))] : [job.product, ...job.terms];
    if (room > 0 && terms.length > 0) {
      pool = await withTenant(job.tenant_id, async (tx) => {
        const finder = getFinder('products');
        const query: FinderQuery = {
          products: terms,
          country: task.country,
          limit: room,
          excludeCompanyIds: kept.map((k) => k.company_id),
        };
        const startedAt = Date.now();
        const candidates = await finder.find(tx, job.tenant_id, query);
        await tx`
          insert into finder_runs (tenant_id, finder, query, result_count, duration_ms)
          values (${job.tenant_id}, ${finder.name}, ${tx.json(query as never)},
                  ${candidates.length}, ${Date.now() - startedAt})
        `;
        return candidates.map((c) => ({
          company_id: c.companyId,
          score: c.score,
          reasons: c.reasons,
          tier: 'pool' as const,
          persona_id: null,
          fit: null,
          evidence: [],
        }));
      });
    }

    const rows = [...kept, ...pool].map((r, i) => ({ ...r, rank: i + 1 }));
    await withTenant(job.tenant_id, async (tx) => {
      await tx`delete from discovery_results where task_id = ${task.id}`;
      if (rows.length === 0) return;
      await tx`
        insert into discovery_results
          (tenant_id, job_id, task_id, company_id, rank, score, reasons, tier, persona_id, fit, evidence)
        select ${job.tenant_id}, ${job.id}, ${task.id}, r.company_id, r.rank, r.score,
               array(select e.reason
                     from jsonb_array_elements_text(r.reasons) with ordinality as e (reason, n)
                     order by e.n),
               r.tier, r.persona_id, r.fit, r.evidence
        from jsonb_to_recordset(${tx.json(rows as never)})
          as r (company_id uuid, rank int, score real, reasons jsonb, tier text,
                persona_id uuid, fit text, evidence jsonb)
      `;
    });

    // Each result says its tier; the count is the whole ranking.
    return { ranked: rows.length };
  },
};

const search: TaskStage = { name: 'search', needs: searchNeeds, run: runSearch };
const triage: TaskStage = { name: 'triage', needs: searchNeeds, run: runTriage };

// Reads only what triage kept, so without the providers it has nothing to do.
const readExtract: TaskStage = { name: 'read_extract', run: runReadExtract };

const TASK_STAGES: readonly TaskStage[] = [search, triage, readExtract, rank];

/**
 * `discovery.task`: run one country of a job through its stages, then settle
 * the task and, if it was the last one open, the job.
 *
 * Throws on a retryable failure so pg-boss retries. `finalAttempt` says this
 * was the last try, so the task is failed with the error before it
 * propagates; a permanent error fails it at once. A task already done,
 * failed, or being run by another live delivery is left alone.
 */
export async function runTask(
  data: TaskJob,
  opts: { finalAttempt?: boolean } = {},
): Promise<Outcome> {
  const claimed = await withTenant(data.tenantId, async (tx) => {
    const [task] = await tx<TaskRow[]>`
      update discovery_tasks set
        status = 'running', started_at = now(), attempts = attempts + 1, deferred_until = null
      where id = ${data.taskId}
        and (status = 'queued'
             or (status = 'running' and started_at < now() - make_interval(secs => ${RUN_EXPIRY_SECONDS})))
      returning *
    `;
    return task ?? null;
  });
  if (!claimed) return 'skipped';

  for (const stage of TASK_STAGES) {
    const task = await readTask(data.tenantId, data.taskId);
    const job = task ? await readJob(data.tenantId, task.job_id) : undefined;
    if (!task || !job) return 'skipped';
    if (task.stages_done.includes(stage.name)) continue;

    if (stage.needs && !stage.needs()) {
      await recordTaskStage(task, stage.name, { [`skipped_${stage.name}`]: 1 });
      continue;
    }

    await withTenant(data.tenantId, (tx) => tx`
      update discovery_tasks set stage = ${stage.name} where id = ${task.id}
    `);
    try {
      const counts = await stage.run(job, task);
      await recordTaskStage(task, stage.name, counts);
    } catch (err) {
      if (err instanceof UsageLimitError) return deferTask(job, task, err.resetsAt);
      if (err instanceof PermanentError || opts.finalAttempt) {
        await settle(job, task, 'failed', (err as Error).message);
        if (err instanceof PermanentError) return 'failed';
        throw err;
      }
      await withTenant(data.tenantId, (tx) => tx`
        update discovery_tasks set status = 'queued' where id = ${task.id} and status = 'running'
      `);
      throw err;
    }
  }

  const task = await readTask(data.tenantId, data.taskId);
  const job = task ? await readJob(data.tenantId, task.job_id) : undefined;
  if (!task || !job) return 'skipped';
  await settle(job, task, 'done');
  return 'done';
}

async function readTask(tenantId: string, taskId: string): Promise<TaskRow | undefined> {
  const [task] = await withTenant(tenantId, (tx) => tx<TaskRow[]>`select * from discovery_tasks where id = ${taskId}`);
  return task;
}

async function recordTaskStage(task: TaskRow, name: string, counts: Counts): Promise<void> {
  await withTenant(task.tenant_id, (tx) => tx`
    update discovery_tasks
    set stages_done = array_append(stages_done, ${name}),
        counts = counts || ${tx.json(counts)}
    where id = ${task.id}
  `);
}

/** Wait out a usage limit: the task goes back to the queue for the reset. */
async function deferTask(job: JobRow, task: TaskRow, resetsAt: Date | null): Promise<Outcome> {
  if (task.deferrals >= env().DISCOVERY_MAX_DEFERRALS) {
    await settle(job, task, 'failed', 'usage limit not cleared');
    return 'failed';
  }
  const until = deferUntil(resetsAt);
  await withTenant(task.tenant_id, async (tx) => {
    await tx`
      update discovery_tasks
      set status = 'queued', deferred_until = ${until}, deferrals = deferrals + 1,
          attempts = greatest(attempts - 1, 0)
      where id = ${task.id}
    `;
    await enqueueTask(tx, task, secondsUntil(until));
    await emit(tx, {
      tenantId: task.tenant_id,
      type: 'discovery.task.deferred',
      subjectType: 'discovery_job',
      subjectId: job.id,
      payload: { jobId: job.id, taskId: task.id, country: task.country, resetsAt: until.toISOString() },
    });
  });
  return 'deferred';
}

/** Close the task, then the job if no task of it is still open. */
async function settle(
  job: JobRow,
  task: TaskRow,
  status: 'done' | 'failed',
  error?: string,
): Promise<void> {
  await withTenant(job.tenant_id, async (tx) => {
    const [settled] = await tx<TaskRow[]>`
      update discovery_tasks set status = ${status}, error = ${error ?? null}, finished_at = now()
      where id = ${task.id} and status = 'running'
      returning *
    `;
    if (!settled) return;

    await emit(tx, {
      tenantId: job.tenant_id,
      type: status === 'done' ? 'discovery.task.finished' : 'discovery.task.failed',
      subjectType: 'discovery_job',
      subjectId: job.id,
      payload:
        status === 'done'
          ? { jobId: job.id, taskId: task.id, country: task.country, counts: settled.counts }
          : { jobId: job.id, taskId: task.id, country: task.country, error, attempts: settled.attempts },
    });

    await finishJob(tx, job.id);
  });
}

/**
 * Finish the job once none of its tasks is queued or running: done if any
 * task is done, failed otherwise, with its tasks' counts summed.
 *
 * The job row is locked first, so two tasks settling at once queue up here and
 * the second sees the first as settled: exactly one of them finishes the job.
 */
async function finishJob(tx: Tx, jobId: string): Promise<void> {
  const [job] = await tx<JobRow[]>`select * from discovery_jobs where id = ${jobId} for update`;
  if (!job || job.status !== 'running') return;

  const [open] = await tx<{ n: number }[]>`
    select count(*)::int as n from discovery_tasks
    where job_id = ${jobId} and status in ('queued', 'running')
  `;
  if ((open?.n ?? 0) > 0) return;

  // The plan's own counts (aliases, personas) stay; the tasks' are summed in.
  const [finished] = await tx<JobRow[]>`
    update discovery_jobs set
      status = case
                 when exists (select 1 from discovery_tasks where job_id = ${jobId} and status = 'done')
                 then 'done' else 'failed'
               end,
      counts = counts || (
        select coalesce(jsonb_object_agg(key, total), '{}'::jsonb)
        from (
          select e.key, sum(e.value::numeric) as total
          from discovery_tasks t
          cross join lateral jsonb_each_text(t.counts) e
          where t.job_id = ${jobId}
          group by e.key
        ) sums
      ),
      finished_at = now()
    where id = ${jobId}
    returning *
  `;
  if (!finished) return;

  await emit(tx, {
    tenantId: finished.tenant_id,
    type: 'discovery.job.finished',
    subjectType: 'discovery_job',
    subjectId: finished.id,
    payload: { jobId: finished.id, status: finished.status, counts: finished.counts },
  });
}
