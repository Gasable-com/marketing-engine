import type { Tx } from '../../db/client.js';
import { emit } from '../../spine/events/index.js';
import { DiscoveryError } from './errors.js';
import { createJob, type JobRow, type Side, type TaskRow } from './jobs.js';

/**
 * RFQ searches: a corporate's RFQ with several products is one search, made
 * of one product search per line. Each line is planned, searched, read and
 * ranked exactly like any search; the RFQ search only groups them, and
 * finishes once its last line does.
 */

export const MAX_RFQ_LINES = 20;

export type RfqSearchRow = {
  id: string;
  tenant_id: string;
  rfq_ref: string | null;
  requester_ref: string | null;
  side: Side;
  countries: string[];
  status: 'running' | 'done' | 'failed';
  counts: Record<string, number>;
  created_at: Date;
  finished_at: Date | null;
};

export type RfqLineInput = {
  lineRef?: string | undefined;
  product: string;
  category?: string | undefined;
  productRef?: string | undefined;
};

export type RfqInput = {
  tenantId: string;
  rfqRef?: string | undefined;
  requesterRef?: string | undefined;
  side?: Side | undefined;
  countries: string[];
  lines: RfqLineInput[];
  resultLimit?: number | undefined;
};

/**
 * Create the RFQ search and one product search per line, on the caller's
 * transaction: all of it commits, or none of it does.
 */
export async function createRfqSearch(
  tx: Tx,
  input: RfqInput,
): Promise<{ rfq: RfqSearchRow; jobs: { job: JobRow; tasks: TaskRow[] }[] }> {
  if (input.lines.length < 1 || input.lines.length > MAX_RFQ_LINES) {
    throw new DiscoveryError('invalid_lines', 400, `an RFQ search has 1 to ${MAX_RFQ_LINES} lines`);
  }
  const side = input.side ?? 'suppliers';
  const countries = input.countries.map((c) => c.trim().toUpperCase());

  const [rfq] = await tx<RfqSearchRow[]>`
    insert into discovery_rfq_searches (tenant_id, rfq_ref, requester_ref, side, countries, status)
    values (${input.tenantId}, ${input.rfqRef?.trim() || null}, ${input.requesterRef ?? null},
            ${side}, ${countries}, 'running')
    returning *
  `;
  if (!rfq) throw new Error('createRfqSearch wrote no RFQ search');

  const jobs: { job: JobRow; tasks: TaskRow[] }[] = [];
  for (const [position, line] of input.lines.entries()) {
    jobs.push(
      await createJob(tx, {
        tenantId: input.tenantId,
        product: line.product,
        category: line.category,
        countries,
        side,
        resultLimit: input.resultLimit,
        requesterRef: input.requesterRef,
        productRef: line.productRef,
        rfq: { searchId: rfq.id, lineRef: line.lineRef?.trim() || null, position },
      }),
    );
  }

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'discovery.rfq.created',
    subjectType: 'discovery_rfq_search',
    subjectId: rfq.id,
    payload: {
      rfqSearchId: rfq.id,
      rfqRef: rfq.rfq_ref,
      requesterRef: rfq.requester_ref,
      lines: jobs.map(({ job }) => ({ lineRef: job.line_ref, jobId: job.id, product: job.product })),
    },
  });

  return { rfq, jobs };
}

/**
 * Finish the RFQ search once none of its lines is still planning or running:
 * done if any line is done, failed otherwise, with the lines' counts summed.
 * Called on the transaction that settles a line; the RFQ row is locked first,
 * so two lines settling at once finish it exactly once.
 */
export async function finishRfqSearch(tx: Tx, rfqSearchId: string): Promise<void> {
  const [rfq] = await tx<RfqSearchRow[]>`
    select * from discovery_rfq_searches where id = ${rfqSearchId} for update
  `;
  if (!rfq || rfq.status !== 'running') return;

  const lines = await tx<{ id: string; line_ref: string | null; status: string; counts: Record<string, number> }[]>`
    select id::text, line_ref, status, counts from discovery_jobs
    where rfq_search_id = ${rfqSearchId}
    order by line_position
  `;
  if (lines.some((l) => l.status === 'planning' || l.status === 'running')) return;

  const [finished] = await tx<RfqSearchRow[]>`
    update discovery_rfq_searches set
      status = ${lines.some((l) => l.status === 'done') ? 'done' : 'failed'},
      counts = (
        select coalesce(jsonb_object_agg(key, total), '{}'::jsonb)
        from (
          select e.key, sum(e.value::numeric) as total
          from discovery_jobs j
          cross join lateral jsonb_each_text(j.counts) e
          where j.rfq_search_id = ${rfqSearchId} and e.value ~ '^-?[0-9.]+$'
          group by e.key
        ) sums
      ),
      finished_at = now()
    where id = ${rfqSearchId}
    returning *
  `;
  if (!finished) return;

  await emit(tx, {
    tenantId: finished.tenant_id,
    type: 'discovery.rfq.finished',
    subjectType: 'discovery_rfq_search',
    subjectId: finished.id,
    payload: {
      rfqSearchId: finished.id,
      rfqRef: finished.rfq_ref,
      requesterRef: finished.requester_ref,
      status: finished.status,
      lines: lines.map((l) => ({ lineRef: l.line_ref, jobId: l.id, status: l.status, ranked: l.counts['ranked'] ?? 0 })),
    },
  });
}
