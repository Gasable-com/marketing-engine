import { db } from '../../../db/client.js';
import { availability, type PromocodeRow } from '../../../modules/promocodes/index.js';

/**
 * The promocodes section of the operator read side: every code with what its
 * budget has spent, cross-tenant. The numbers are the ones `validate` checks
 * the budget against, so the screen and checkout cannot disagree.
 */

type Row = PromocodeRow & {
  tenant_name: string;
  reserved_count: string;
  reserved_amount: string;
  settled_count: string;
  settled_amount: string;
  released_count: string;
  released_amount: string;
  buyers: string;
  last_redeemed_at: Date | null;
};

/** A function, so importing this file opens no pool. */
const select = () => db()`
  select p.*, t.name as tenant_name,
         count(r.id) filter (where r.status = 'reserved')::text as reserved_count,
         coalesce(sum(r.discount_amount) filter (where r.status = 'reserved'), 0)::text as reserved_amount,
         count(r.id) filter (where r.status = 'settled')::text as settled_count,
         coalesce(sum(r.discount_amount) filter (where r.status = 'settled'), 0)::text as settled_amount,
         count(r.id) filter (where r.status = 'released')::text as released_count,
         coalesce(sum(r.discount_amount) filter (where r.status = 'released'), 0)::text as released_amount,
         count(distinct r.buyer_ref) filter (where r.status in ('reserved', 'settled'))::text as buyers,
         max(r.reserved_at) as last_redeemed_at
  from promocodes p
  join tenants t on t.id = p.tenant_id
  left join redemptions r on r.promocode_id = p.id
`;

function shape(row: Row, now: Date) {
  const part = (count: string, amount: string) => ({ count: Number(count), amount: Number(amount) });
  const reserved = part(row.reserved_count, row.reserved_amount);
  const settled = part(row.settled_count, row.settled_amount);
  const released = part(row.released_count, row.released_amount);

  const uses = reserved.count + settled.count;
  const spend = reserved.amount + settled.amount;
  const { maxUses, maxSpend } = row.budget;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    code: row.code,
    currency: row.currency,
    discount: row.discount,
    rules: row.rules,
    budget: row.budget,
    funders: row.funders,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    usage: {
      uses,
      spend,
      reserved,
      settled,
      released,
      buyers: Number(row.buyers),
      remainingUses: maxUses === undefined ? null : Math.max(0, maxUses - uses),
      remainingSpend: maxSpend === undefined ? null : Math.max(0, maxSpend - spend),
      lastRedeemedAt: row.last_redeemed_at,
    },
    availability: availability(row, { uses, spend }, now),
  };
}

export async function promocodes(input: {
  tenantId?: string | undefined;
  status?: string | undefined;
  code?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}) {
  const sql = db();
  // Escape LIKE's wildcards: a code is matched as typed, from its start.
  const prefix = input.code ? `${input.code.replace(/[\\%_]/g, '\\$&')}%` : null;

  const rows = await sql<Row[]>`
    ${select()}
    where true
      ${input.tenantId ? sql`and p.tenant_id = ${input.tenantId}` : sql``}
      ${input.status ? sql`and p.status = ${input.status}` : sql``}
      ${prefix ? sql`and p.code ilike ${prefix}` : sql``}
      ${input.cursor ? sql`and (p.created_at, p.id) < (select created_at, id from promocodes where id = ${input.cursor})` : sql``}
    group by p.id, t.name
    order by p.created_at desc, p.id desc
    limit ${input.limit}
  `;
  const now = new Date();
  return rows.map((row) => shape(row, now));
}

export async function onePromocode(id: string) {
  const [row] = await db()<Row[]>`
    ${select()}
    where p.id = ${id}
    group by p.id, t.name
  `;
  return row ? shape(row, new Date()) : undefined;
}
