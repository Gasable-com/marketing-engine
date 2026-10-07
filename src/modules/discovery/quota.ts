import type { Tx } from '../../db/client.js';
import { decide } from '../../spine/rules/index.js';
import { DiscoveryError } from './errors.js';

/**
 * How many searches one requester (a portal supplier or corporate) may start:
 * the discovery.quota rule, per calendar day and month in its time zone. An
 * RFQ search counts as one search, however many products it has. Operator
 * searches carry no requester and are never counted.
 */

export type QuotaWindow = { used: number; max: number; resetsAt: Date };
export type Quota = { day: QuotaWindow; month: QuotaWindow };

type QuotaRule = { day?: number; month?: number; timezone?: string };

export async function quotaFor(tx: Tx, tenantId: string, requesterRef: string): Promise<Quota> {
  const { value } = await decide<QuotaRule>(tx, { kind: 'discovery.quota', tenantId, region: null, context: {} });
  const maxDay = typeof value?.day === 'number' ? value.day : 5;
  const maxMonth = typeof value?.month === 'number' ? value.month : 50;
  const zone = typeof value?.timezone === 'string' ? value.timezone : 'Asia/Riyadh';

  const [row] = await tx<{ day_start: Date; day_end: Date; month_start: Date; month_end: Date; day_used: number; month_used: number }[]>`
    with bounds as (
      select (date_trunc('day', now() at time zone ${zone}) at time zone ${zone}) as day_start,
             ((date_trunc('day', now() at time zone ${zone}) + interval '1 day') at time zone ${zone}) as day_end,
             (date_trunc('month', now() at time zone ${zone}) at time zone ${zone}) as month_start,
             ((date_trunc('month', now() at time zone ${zone}) + interval '1 month') at time zone ${zone}) as month_end
    ),
    started as (
      select created_at from discovery_jobs
      where tenant_id = ${tenantId} and requester_ref = ${requesterRef} and rfq_search_id is null
      union all
      select created_at from discovery_rfq_searches
      where tenant_id = ${tenantId} and requester_ref = ${requesterRef}
    )
    select b.day_start, b.day_end, b.month_start, b.month_end,
           (select count(*)::int from started s where s.created_at >= b.day_start) as day_used,
           (select count(*)::int from started s where s.created_at >= b.month_start) as month_used
    from bounds b
  `;
  return {
    day: { used: row!.day_used, max: maxDay, resetsAt: row!.day_end },
    month: { used: row!.month_used, max: maxMonth, resetsAt: row!.month_end },
  };
}

/**
 * Refuse a search over either limit. Holds a lock on the requester for the
 * rest of the caller's transaction, so two searches started at once cannot
 * both squeeze under the limit.
 */
export async function assertQuota(tx: Tx, tenantId: string, requesterRef: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${`discovery-quota:${tenantId}:${requesterRef}`}))`;
  const quota = await quotaFor(tx, tenantId, requesterRef);
  for (const limit of ['day', 'month'] as const) {
    const w = quota[limit];
    if (w.used >= w.max) {
      throw new DiscoveryError('quota_exceeded', 429, `at most ${w.max} searches a ${limit}`, {
        limit,
        used: w.used,
        max: w.max,
        resetsAt: w.resetsAt.toISOString(),
      });
    }
  }
}
