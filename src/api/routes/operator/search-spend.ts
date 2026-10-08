import { db } from '../../../db/client.js';
import { QUERIED_EVENT, usdFor } from '../../../modules/discovery/index.js';
import type { Window } from './shared.js';

/**
 * What the searches cost, read from the `discovery.task.queried` events the
 * search stage appends: one per query, with the credits Serper charged, or
 * none when the cache answered. The log is the only source; the task counts
 * are for display. Money is credits times the price now, so a corrected
 * `SERPER_USD_PER_CREDIT` corrects every figure here at once.
 */

export type Spend = { queries: number; serperCalls: number; cacheHits: number; credits: number; usd: number };

type Average = { credits: number; usd: number };

export type Totals = Spend & {
  /** Jobs that made at least one query. */
  searches: number;
  cacheRate: number | null;
  perSearch: Average | null;
  perQuery: Average | null;
  perCall: Average | null;
};

export type SpendRow = { queries: number; serper_calls: number; cache_hits: number; credits: number };

/** The aggregate every figure shares, over the events aliased `e` in scope. */
export const spendColumns = () => db()`
  count(*)::int as queries,
  count(*) filter (where not (e.payload->>'cached')::boolean)::int as serper_calls,
  count(*) filter (where (e.payload->>'cached')::boolean)::int as cache_hits,
  coalesce(sum((e.payload->>'credits')::int), 0)::int as credits
`;

export function spendOf(r: SpendRow | undefined): Spend {
  const credits = r?.credits ?? 0;
  return {
    queries: r?.queries ?? 0,
    serperCalls: r?.serper_calls ?? 0,
    cacheHits: r?.cache_hits ?? 0,
    credits,
    usd: usdFor(credits),
  };
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

const inWindow = (window: Window | null) =>
  window ? db()`and e.occurred_at >= ${window.since} and e.occurred_at < ${window.until}` : db()``;

/** Totals and averages, in a window or (with `null`) since the beginning. */
export async function totals(window: Window | null): Promise<Totals> {
  const [row] = await db()<(SpendRow & { searches: number })[]>`
    select count(distinct e.subject_id)::int as searches, ${spendColumns()}
    from events e
    where e.type = ${QUERIED_EVENT} ${inWindow(window)}
  `;
  const spend = spendOf(row);
  const searches = row?.searches ?? 0;
  const average = (over: number): Average | null =>
    over > 0 ? { credits: round(spend.credits / over, 2), usd: round(spend.usd / over, 6) } : null;
  return {
    ...spend,
    searches,
    cacheRate: spend.queries > 0 ? round(spend.cacheHits / spend.queries, 3) : null,
    perSearch: average(searches),
    perQuery: average(spend.queries),
    perCall: average(spend.serperCalls),
  };
}

export async function byKind(window: Window) {
  const rows = await db()<(SpendRow & { kind: string })[]>`
    select e.payload->>'kind' as kind, ${spendColumns()}
    from events e
    where e.type = ${QUERIED_EVENT} ${inWindow(window)}
    group by 1 order by 1
  `;
  return rows.map((r) => ({ kind: r.kind, ...spendOf(r) }));
}

export async function byCountry(window: Window) {
  const rows = await db()<(SpendRow & { country: string })[]>`
    select e.payload->>'country' as country, ${spendColumns()}
    from events e
    where e.type = ${QUERIED_EVENT} ${inWindow(window)}
    group by 1 order by credits desc, 1
    limit 20
  `;
  return rows.map((r) => ({ country: r.country, ...spendOf(r) }));
}

export async function byTenant(window: Window) {
  const rows = await db()<(SpendRow & { tenant_id: string; tenant_name: string })[]>`
    select e.tenant_id::text as tenant_id, t.name as tenant_name, ${spendColumns()}
    from events e
    join tenants t on t.id = e.tenant_id
    where e.type = ${QUERIED_EVENT} ${inWindow(window)}
    group by 1, 2 order by credits desc, 2
  `;
  return rows.map((r) => ({ tenantId: r.tenant_id, tenantName: r.tenant_name, ...spendOf(r) }));
}

/** The costliest jobs in the window, with what they were. */
export async function topSearches(window: Window, limit = 5) {
  const rows = await db()<
    (SpendRow & {
      job_id: string;
      product: string;
      side: string;
      countries: string[];
      tenant_id: string;
      tenant_name: string;
    })[]
  >`
    select e.subject_id as job_id, coalesce(j.identified->>'name', j.product) as product, j.side,
           j.countries, j.tenant_id::text as tenant_id, t.name as tenant_name, ${spendColumns()}
    from events e
    join discovery_jobs j on j.id::text = e.subject_id
    join tenants t on t.id = j.tenant_id
    where e.type = ${QUERIED_EVENT} ${inWindow(window)}
    group by e.subject_id, j.id, t.name
    order by credits desc, e.subject_id
    limit ${limit}
  `;
  return rows.map((r) => ({
    jobId: r.job_id,
    product: r.product,
    side: r.side,
    countries: r.countries,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    ...spendOf(r),
  }));
}

const TWO_DAYS_MS = 48 * 60 * 60 * 1000;

/**
 * Spend over time, every bucket present so a chart is honest about quiet
 * hours: hourly up to two days, daily beyond.
 */
export async function series(window: Window) {
  const bucket = window.until.getTime() - window.since.getTime() <= TWO_DAYS_MS ? 'hour' : 'day';
  const rows = await db()<(SpendRow & { at: Date })[]>`
    with buckets as (
      select generate_series(date_trunc(${bucket}, ${window.since}::timestamptz),
                             date_trunc(${bucket}, ${window.until}::timestamptz),
                             ${`1 ${bucket}`}::interval) as at
    ), spent as (
      select date_trunc(${bucket}, e.occurred_at) as at, ${spendColumns()}
      from events e
      where e.type = ${QUERIED_EVENT} ${inWindow(window)}
      group by 1
    )
    select b.at, coalesce(s.queries, 0)::int as queries,
           coalesce(s.serper_calls, 0)::int as serper_calls,
           coalesce(s.cache_hits, 0)::int as cache_hits,
           coalesce(s.credits, 0)::int as credits
    from buckets b
    left join spent s on s.at = b.at
    order by b.at
  `;
  return { bucket, points: rows.map((r) => ({ at: r.at.toISOString(), ...spendOf(r) })) };
}

/** One job's spend and each of its tasks', from the job's own events. */
export async function spendOfJob(tenantId: string, jobId: string): Promise<{ job: Spend; tasks: Map<string, Spend> }> {
  const rows = await db()<(SpendRow & { task_id: string })[]>`
    select e.payload->>'taskId' as task_id, ${spendColumns()}
    from events e
    where e.tenant_id = ${tenantId} and e.type = ${QUERIED_EVENT} and e.subject_id = ${jobId}
    group by 1
  `;
  const whole = rows.reduce<SpendRow>(
    (sum, r) => ({
      queries: sum.queries + r.queries,
      serper_calls: sum.serper_calls + r.serper_calls,
      cache_hits: sum.cache_hits + r.cache_hits,
      credits: sum.credits + r.credits,
    }),
    { queries: 0, serper_calls: 0, cache_hits: 0, credits: 0 },
  );
  return { job: spendOf(whole), tasks: new Map(rows.map((r) => [r.task_id, spendOf(r)])) };
}

/** Every query, newest first: the log the spend figures are summed from. */
export async function queries(input: {
  jobId?: string | undefined;
  tenantId?: string | undefined;
  country?: string | undefined;
  kind?: string | undefined;
  cached?: boolean | undefined;
  /** `null` for a job's whole history; the window is for the firehose. */
  window: Window | null;
  limit: number;
  cursor?: string | undefined;
}) {
  const sql = db();
  const rows = await sql<(Record<string, unknown> & { credits: number })[]>`
    select e.id::text as id, e.occurred_at as at,
           e.tenant_id::text as "tenantId", t.name as "tenantName",
           e.subject_id as "jobId", coalesce(j.identified->>'name', j.product) as product, j.side,
           e.payload->>'taskId' as "taskId", e.payload->>'country' as country, p.name as persona,
           e.payload->>'kind' as kind, e.payload->>'q' as q, e.payload->>'gl' as gl, e.payload->>'hl' as hl,
           (e.payload->>'cached')::boolean as cached, (e.payload->>'credits')::int as credits,
           (e.payload->>'hits')::int as hits
    from events e
    join tenants t on t.id = e.tenant_id
    left join discovery_jobs j on j.id::text = e.subject_id
    left join discovery_personas p on p.id::text = e.payload->>'personaId'
    where e.type = ${QUERIED_EVENT} ${inWindow(input.window)}
      ${input.jobId ? sql`and e.subject_id = ${input.jobId}` : sql``}
      ${input.tenantId ? sql`and e.tenant_id = ${input.tenantId}` : sql``}
      ${input.country ? sql`and e.payload->>'country' = ${input.country}` : sql``}
      ${input.kind ? sql`and e.payload->>'kind' = ${input.kind}` : sql``}
      ${input.cached === undefined ? sql`` : sql`and (e.payload->>'cached')::boolean = ${input.cached}`}
      ${input.cursor ? sql`and e.id < ${input.cursor}` : sql``}
    order by e.id desc
    limit ${input.limit}
  `;
  return rows.map((r) => ({ ...r, usd: usdFor(r.credits) }));
}
