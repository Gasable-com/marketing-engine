import { withTenant } from '../../../db/client.js';
import { env } from '../../../env.js';
import { emit } from '../../../spine/events/index.js';
import type { TaskRow } from '../jobs.js';
import type { Cached } from './cache.js';

/**
 * Serper bills in credits and the operator thinks in money. A credit's price
 * depends on the pack bought, so it is configuration, and every money figure
 * is worked out when it is read: credits from the event log times the price
 * now. A corrected price corrects every figure at once, past and future.
 */

/** The event appended for every Serper query, cached or not. */
export const QUERIED_EVENT = 'discovery.task.queried';

export type Queried = {
  /** The persona a search query is for; none for a lookup about one company. */
  personaId: string | null;
  kind: 'web' | 'places';
  q: string;
  gl: string;
  hl: string;
  /** What a query outside the search stage looked up. */
  lookup?: 'linkedin';
};

/**
 * Spent is spent: every query goes on the event log as it happens, so a task
 * that fails on its twelfth query still has its first eleven on record. The
 * log is what the operator's spend figures are read from.
 */
export async function recordQuery(task: TaskRow, query: Queried, result: Cached<unknown>): Promise<void> {
  await withTenant(task.tenant_id, (tx) =>
    emit(tx, {
      tenantId: task.tenant_id,
      type: QUERIED_EVENT,
      subjectType: 'discovery_job',
      subjectId: task.job_id,
      payload: {
        jobId: task.job_id,
        taskId: task.id,
        country: task.country,
        personaId: query.personaId,
        provider: 'serper',
        kind: query.kind,
        q: query.q,
        gl: query.gl,
        hl: query.hl,
        page: 1,
        cached: result.fromCache,
        credits: result.credits,
        hits: result.hits.length,
        ...(query.lookup ? { lookup: query.lookup } : {}),
      },
    }),
  );
}

export function usdPerCredit(): number {
  return env().SERPER_USD_PER_CREDIT;
}

/** Rounded to a millionth of a dollar, so sums of float products stay clean. */
export function usdFor(credits: number): number {
  return Math.round(credits * usdPerCredit() * 1e6) / 1e6;
}
