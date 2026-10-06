import { withTenant, type Tx } from '../../db/client.js';
import { enqueue } from '../../jobs/queue.js';
import { emit } from '../../spine/events/index.js';
import { DiscoveryError } from './errors.js';
import { getFinder, type FinderQuery } from './finder/index.js';

/**
 * Discovery jobs: an operator's search for a product across one or more
 * countries. A job is one task per country on the queue, and a task is a run
 * through STAGES, in order. Nothing here calls the network.
 */

export const DISCOVERY_TASK_JOB = 'discovery.task';

/** pg-boss retries per task before the task is failed. */
export const TASK_RETRY_LIMIT = 3;

export const DEFAULT_RESULT_LIMIT = 50;
export const MAX_RESULT_LIMIT = 200;
export const MAX_COUNTRIES = 10;

export type JobRow = {
  id: string;
  tenant_id: string;
  product: string;
  category: string | null;
  side: 'suppliers';
  countries: string[];
  terms: string[];
  result_limit: number;
  status: 'running' | 'done' | 'failed';
  counts: Counts;
  created_at: Date;
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
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

/** What a stage did, by name. A task's counts merge its stages'; a job's sum its tasks'. */
export type Counts = Record<string, number>;

export type TaskJob = { tenantId: string; taskId: string };

export type JobInput = {
  tenantId: string;
  product: string;
  category?: string | undefined;
  countries: string[];
  resultLimit?: number | undefined;
};

/**
 * Create a job and queue its tasks, one per country. On the caller's
 * transaction, so the job, its tasks and their queue entries commit together
 * or not at all.
 */
export async function createJob(
  tx: Tx,
  input: JobInput,
): Promise<{ job: JobRow; tasks: TaskRow[] }> {
  const { product, category, countries, resultLimit } = validate(input);

  const [job] = await tx<JobRow[]>`
    insert into discovery_jobs (tenant_id, product, category, countries, result_limit, status)
    values (${input.tenantId}, ${product}, ${category}, ${countries}, ${resultLimit}, 'running')
    returning *
  `;
  if (!job) throw new Error('createJob wrote no job');

  const tasks: TaskRow[] = [];
  for (const country of countries) {
    const [task] = await tx<TaskRow[]>`
      insert into discovery_tasks (tenant_id, job_id, country, status)
      values (${input.tenantId}, ${job.id}, ${country}, 'queued')
      returning *
    `;
    if (!task) throw new Error('createJob wrote no task');
    tasks.push(task);

    await enqueue(
      tx,
      DISCOVERY_TASK_JOB,
      { tenantId: input.tenantId, taskId: task.id } satisfies TaskJob,
      { singletonKey: task.id, retryLimit: TASK_RETRY_LIMIT, retryBackoff: true },
    );
  }

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'discovery.job.created',
    subjectType: 'discovery_job',
    subjectId: job.id,
    payload: { jobId: job.id, product, countries },
  });

  return { job, tasks };
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

  return { product, category, countries, resultLimit };
}

/**
 * A stage: a named async function that does one step of a task and says what
 * it did. Each opens its own transactions, so a stage that waits on the
 * network later holds no database transaction while it waits.
 */
export type Stage = (job: JobRow, task: TaskRow) => Promise<Counts>;

/**
 * Rank the pool for the task's country with the `products` finder, and make
 * the result the task's results: a rerun replaces them.
 */
async function rank(job: JobRow, task: TaskRow): Promise<Counts> {
  return withTenant(job.tenant_id, async (tx) => {
    const finder = getFinder('products');
    const query: FinderQuery = {
      products: [job.product, ...job.terms],
      country: task.country,
      limit: job.result_limit,
    };

    const startedAt = Date.now();
    const candidates = await finder.find(tx, job.tenant_id, query);

    await tx`
      insert into finder_runs (tenant_id, finder, query, result_count, duration_ms)
      values (${job.tenant_id}, ${finder.name}, ${tx.json(query as never)},
              ${candidates.length}, ${Date.now() - startedAt})
    `;

    await tx`delete from discovery_results where task_id = ${task.id}`;
    if (candidates.length > 0) {
      const rows = candidates.map((c, i) => ({
        company_id: c.companyId,
        rank: i + 1,
        score: c.score,
        reasons: c.reasons,
      }));
      await tx`
        insert into discovery_results (tenant_id, job_id, task_id, company_id, rank, score, reasons)
        select ${job.tenant_id}, ${job.id}, ${task.id}, r.company_id, r.rank, r.score,
               array(select e.reason
                     from jsonb_array_elements_text(r.reasons) with ordinality as e (reason, n)
                     order by e.n)
        from jsonb_to_recordset(${tx.json(rows as never)})
          as r (company_id uuid, rank int, score real, reasons jsonb)
      `;
    }

    return { ranked: candidates.length };
  });
}

/**
 * The stages a task runs through, in order. Steps 19 and 20 add search,
 * triage, read and extract in front of rank. A plain array, not a plugin
 * system: a stage's name is its function's name.
 */
const STAGES: readonly Stage[] = [rank];

/**
 * `discovery.task`: run one country of a job through every stage, then settle
 * the task and, if it was the last one open, the job.
 *
 * Throws on failure so pg-boss retries. `finalAttempt` says this was the last
 * try, so the task is failed with the error before it propagates. A task
 * already done or failed is left alone, so a second delivery does nothing.
 */
export async function runTask(
  data: TaskJob,
  opts: { finalAttempt?: boolean } = {},
): Promise<TaskRow['status'] | 'skipped'> {
  const started = await withTenant(data.tenantId, async (tx) => {
    const [task] = await tx<TaskRow[]>`
      update discovery_tasks set
        status = 'running', started_at = now(), attempts = attempts + 1
      where id = ${data.taskId} and status in ('queued', 'running')
      returning *
    `;
    if (!task) return null;
    const [job] = await tx<JobRow[]>`select * from discovery_jobs where id = ${task.job_id}`;
    return job ? { job, task } : null;
  });
  if (!started) return 'skipped';
  const { job, task } = started;

  try {
    for (const stage of STAGES) {
      await withTenant(data.tenantId, (tx) => tx`
        update discovery_tasks set stage = ${stage.name} where id = ${task.id}
      `);
      const counts = await stage(job, task);
      await withTenant(data.tenantId, (tx) => tx`
        update discovery_tasks set counts = counts || ${tx.json(counts)} where id = ${task.id}
      `);
    }
  } catch (err) {
    if (opts.finalAttempt) await settle(job, task, 'failed', (err as Error).message);
    throw err;
  }

  await settle(job, task, 'done');
  return 'done';
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

  const [finished] = await tx<JobRow[]>`
    update discovery_jobs set
      status = case
                 when exists (select 1 from discovery_tasks where job_id = ${jobId} and status = 'done')
                 then 'done' else 'failed'
               end,
      counts = (
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
