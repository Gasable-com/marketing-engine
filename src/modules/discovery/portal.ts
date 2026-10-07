import type { Tx } from '../../db/client.js';
import type { JobRow, TaskRow } from './jobs.js';
import type { RfqSearchRow } from './rfq.js';

/**
 * What a portal user (a supplier or a corporate) sees of discovery: their own
 * searches, and for each result a company's name, city and why it matches.
 * Never an identifier, a phone, an email, a website or a page address: the
 * marketplace keeps the relationship, and outreach goes through it.
 *
 * Every read is scoped by RLS to the tenant, and here to the requester.
 */

export type PortalSearch = {
  id: string;
  requesterRef: string | null;
  productRef: string | null;
  rfqSearchId: string | null;
  lineRef: string | null;
  side: string;
  product: string;
  /** What the product was identified as, once known. */
  identifiedAs: string | null;
  countries: string[];
  status: string;
  /** Where the search is, in a word the portal can show: decided here, not in the UI. */
  progress: 'understanding the product' | 'searching' | 'reading' | 'ranking' | 'done' | 'failed';
  ranked: number | null;
  createdAt: Date;
  finishedAt: Date | null;
};

export type PortalResult = {
  rank: number;
  company: { id: string; name: string };
  city: string | null;
  country: string | null;
  persona: string | null;
  fit: 'strong' | 'weak' | null;
  why: string[];
};

export type PortalRfqSearch = {
  id: string;
  rfqRef: string | null;
  requesterRef: string | null;
  side: string;
  countries: string[];
  status: string;
  lines: (PortalSearch & { position: number })[];
  createdAt: Date;
  finishedAt: Date | null;
};

const STAGE_WORD: Record<string, PortalSearch['progress']> = {
  search: 'searching',
  triage: 'searching',
  read_extract: 'reading',
  rank: 'ranking',
};

export function portalSearch(job: JobRow, tasks: Pick<TaskRow, 'status' | 'stage'>[]): PortalSearch {
  let progress: PortalSearch['progress'];
  if (job.status === 'done') progress = 'done';
  else if (job.status === 'failed') progress = 'failed';
  else if (job.status === 'planning') progress = 'understanding the product';
  else {
    // The furthest-behind open task says where the search is.
    const open = tasks.filter((t) => t.status === 'queued' || t.status === 'running');
    const order = ['search', 'triage', 'read_extract', 'rank'];
    const stage = open
      .map((t) => t.stage ?? 'search')
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    progress = STAGE_WORD[stage ?? 'search'] ?? 'searching';
  }
  return {
    id: job.id,
    requesterRef: job.requester_ref,
    productRef: job.product_ref,
    rfqSearchId: job.rfq_search_id,
    lineRef: job.line_ref,
    side: job.side,
    product: job.product,
    identifiedAs: job.identified?.name ?? null,
    countries: job.countries,
    status: job.status,
    progress,
    ranked: typeof job.counts['ranked'] === 'number' ? job.counts['ranked'] : null,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
  };
}

/** A search the requester owns, with its tasks; undefined for anyone else's. */
export async function ownSearch(
  tx: Tx,
  id: string,
  requesterRef: string,
): Promise<{ job: JobRow; view: PortalSearch } | undefined> {
  const [job] = await tx<JobRow[]>`
    select * from discovery_jobs where id = ${id} and requester_ref = ${requesterRef}
  `;
  if (!job) return undefined;
  const tasks = await tx<TaskRow[]>`select * from discovery_tasks where job_id = ${job.id}`;
  return { job, view: portalSearch(job, tasks) };
}

export async function listSearches(
  tx: Tx,
  input: { requesterRef: string; productRef?: string | undefined; status?: string | undefined; limit: number; cursor?: string | undefined },
): Promise<PortalSearch[]> {
  const jobs = await tx<JobRow[]>`
    select * from discovery_jobs
    where requester_ref = ${input.requesterRef}
      ${input.productRef ? tx`and product_ref = ${input.productRef}` : tx``}
      ${input.status ? tx`and status = ${input.status}` : tx``}
      ${input.cursor ? tx`and (created_at, id) < (select created_at, id from discovery_jobs where id = ${input.cursor})` : tx``}
    order by created_at desc, id desc
    limit ${input.limit}
  `;
  return withTasks(tx, jobs);
}

async function withTasks(tx: Tx, jobs: JobRow[]): Promise<PortalSearch[]> {
  if (jobs.length === 0) return [];
  const tasks = await tx<(Pick<TaskRow, 'status' | 'stage'> & { job_id: string })[]>`
    select job_id::text, status, stage from discovery_tasks where job_id = any(${jobs.map((j) => j.id)}::uuid[])
  `;
  return jobs.map((j) => portalSearch(j, tasks.filter((t) => t.job_id === j.id)));
}

/**
 * A search's ranked results, in the portal's view. `why` is the persona and
 * each checked quote, or the ranking reasons, with every line that names a
 * page left out.
 */
export async function portalResults(tx: Tx, jobId: string): Promise<PortalResult[]> {
  const rows = await tx<
    {
      rank: number;
      company_id: string;
      company_name: string;
      company_country: string | null;
      cities: string[] | null;
      persona_name: string | null;
      fit: 'strong' | 'weak' | null;
      evidence: { claim: string; quote: string }[];
      reasons: string[];
    }[]
  >`
    select r.rank, c.id::text as company_id, c.name as company_name, c.country as company_country,
           p.cities, ps.name as persona_name, r.fit, r.evidence, r.reasons
    from discovery_results r
    join companies c on c.id = r.company_id
    left join company_profiles p on p.company_id = c.id
    left join discovery_personas ps on ps.id = r.persona_id
    where r.job_id = ${jobId}
    order by r.rank, r.id
  `;
  return rows.map((r) => ({
    rank: r.rank,
    company: { id: r.company_id, name: r.company_name },
    city: r.cities?.[0] ?? null,
    country: r.company_country,
    persona: r.persona_name,
    fit: r.fit,
    why: whyOf(r.evidence, r.reasons),
  }));
}

/** Why a company matches, with nothing that would lead to its contacts. */
function whyOf(evidence: { claim: string; quote: string }[], reasons: string[]): string[] {
  const leaks = /https?:\/\/|www\.|@|\+?\d[\d\s-]{7,}/i;
  const lines = evidence.length
    ? evidence.map((e) => `${e.claim}: "${e.quote}"`)
    : reasons.filter((r) => !r.startsWith('persona: '));
  return lines.filter((l) => !leaks.test(l));
}

export function portalRfq(rfq: RfqSearchRow, lines: (PortalSearch & { position: number })[]): PortalRfqSearch {
  return {
    id: rfq.id,
    rfqRef: rfq.rfq_ref,
    requesterRef: rfq.requester_ref,
    side: rfq.side,
    countries: rfq.countries,
    status: rfq.status,
    lines,
    createdAt: rfq.created_at,
    finishedAt: rfq.finished_at,
  };
}

/** An RFQ search the requester owns, with its lines in order; undefined for anyone else's. */
export async function ownRfqSearch(tx: Tx, id: string, requesterRef: string): Promise<PortalRfqSearch | undefined> {
  const [rfq] = await tx<RfqSearchRow[]>`
    select * from discovery_rfq_searches where id = ${id} and requester_ref = ${requesterRef}
  `;
  if (!rfq) return undefined;
  const jobs = await tx<JobRow[]>`
    select * from discovery_jobs where rfq_search_id = ${rfq.id} order by line_position
  `;
  const views = await withTasks(tx, jobs);
  return portalRfq(
    rfq,
    views.map((v, i) => ({ ...v, position: jobs[i]!.line_position ?? i })),
  );
}

export async function listRfqSearches(
  tx: Tx,
  input: { requesterRef: string; rfqRef?: string | undefined; limit: number; cursor?: string | undefined },
): Promise<PortalRfqSearch[]> {
  const rows = await tx<RfqSearchRow[]>`
    select * from discovery_rfq_searches
    where requester_ref = ${input.requesterRef}
      ${input.rfqRef ? tx`and rfq_ref = ${input.rfqRef}` : tx``}
      ${input.cursor ? tx`and (created_at, id) < (select created_at, id from discovery_rfq_searches where id = ${input.cursor})` : tx``}
    order by created_at desc, id desc
    limit ${input.limit}
  `;
  const out: PortalRfqSearch[] = [];
  for (const rfq of rows) out.push((await ownRfqSearch(tx, rfq.id, input.requesterRef))!);
  return out;
}
