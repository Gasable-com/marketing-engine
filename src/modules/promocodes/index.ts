import { db, type Tx } from '../../db/client.js';
import { env } from '../../env.js';
import { emit } from '../../spine/events/index.js';
import { applyDocument, evaluate } from '../../spine/rules/index.js';
import { activeLedger } from './ledger/index.js';
import {
  compute,
  fundersAreValid,
  proportion,
  split,
  splitLines,
  type Cart,
  type Discount,
  type Funder,
  type Line,
} from './money.js';

export * from './money.js';
export * from './ledger/index.js';

export const EXPIRE_JOB = 'promo.expire-reservations';

export class PromocodeError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export type Budget = {
  maxSpend?: number | undefined;
  maxUses?: number | undefined;
  perBuyerMaxUses?: number | undefined;
};

export type PromocodeRow = {
  id: string;
  tenant_id: string;
  code: string;
  currency: string;
  discount: Discount;
  rules: Record<string, unknown> | null;
  budget: Budget;
  funders: Funder[];
  starts_at: Date;
  ends_at: Date | null;
  status: 'active' | 'paused' | 'ended';
  created_at: Date;
  updated_at: Date;
};

export type Hold = { party: string; holdRef: string; amount: number };

export type RedemptionRow = {
  id: string;
  tenant_id: string;
  promocode_id: string;
  buyer_ref: string;
  company_id: string | null;
  order_ref: string;
  currency: string;
  discount_amount: string;
  status: 'reserved' | 'settled' | 'released';
  holds: Hold[];
  reserved_at: Date;
  settled_at: Date | null;
  released_at: Date | null;
  release_reason: string | null;
  expires_at: Date;
};

export type ValidateResult =
  | { valid: true; discountAmount: number; promocodeId: string; lines: Line[] }
  | { valid: false; reason: string; rule?: { id: string; name: string } };

export async function create(
  tx: Tx,
  input: {
    tenantId: string;
    code: string;
    currency: string;
    discount: Discount;
    budget?: Budget | undefined;
    funders: Funder[];
    rules?: Record<string, unknown> | undefined;
    startsAt?: Date | undefined;
    endsAt?: Date | undefined;
  },
): Promise<PromocodeRow> {
  if (!/^[A-Za-z]{3}$/.test(input.currency)) {
    throw new PromocodeError('invalid_currency', 400, 'currency must be a 3-letter code');
  }
  if (!fundersAreValid(input.funders)) {
    throw new PromocodeError('invalid_funders', 400, 'funder shares must sum to 1');
  }
  if (!Number.isSafeInteger(input.discount.value) || input.discount.value < 0) {
    throw new PromocodeError('invalid_discount', 400, 'discount value must be a whole number');
  }

  const [row] = await tx<PromocodeRow[]>`
    insert into promocodes
      (tenant_id, code, currency, discount, rules, budget, funders, starts_at, ends_at)
    values (${input.tenantId}, ${input.code}, ${input.currency.toUpperCase()},
            ${tx.json(input.discount as never)},
            ${input.rules ? tx.json(input.rules as never) : null},
            ${tx.json((input.budget ?? {}) as never)},
            ${tx.json(input.funders as never)},
            ${input.startsAt ?? new Date()}, ${input.endsAt ?? null})
    returning *
  `;
  if (!row) throw new Error('promocodes.create wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'promo.created',
    subjectType: 'promocode',
    subjectId: row.id,
    payload: { code: row.code, currency: row.currency, funders: row.funders },
  });

  return row;
}

export type ValidateInput = {
  tenantId: string;
  code: string;
  buyerRef: string;
  companyId?: string | undefined;
  cart: Cart;
  at?: Date | undefined;
};

/**
 * Can this buyer use this code on this cart, and for how much?
 *
 * Reads only, emits nothing: checkout calls it while the cart is still being
 * edited. The order of checks is fixed and the first failure wins, so the
 * reason a buyer is told is always the most specific true one.
 */
export async function validate(
  tx: Tx,
  input: ValidateInput,
  opts: { lock?: boolean } = {},
): Promise<ValidateResult> {
  const now = input.at ?? new Date();

  const [promo] = opts.lock
    ? await tx<PromocodeRow[]>`
        select * from promocodes
        where tenant_id = ${input.tenantId} and upper(code) = upper(${input.code})
        for update
      `
    : await tx<PromocodeRow[]>`
        select * from promocodes
        where tenant_id = ${input.tenantId} and upper(code) = upper(${input.code})
      `;

  if (!promo) return { valid: false, reason: 'not_found' };

  if (
    promo.status !== 'active' ||
    promo.starts_at.getTime() > now.getTime() ||
    (promo.ends_at && promo.ends_at.getTime() <= now.getTime())
  ) {
    return { valid: false, reason: 'not_active' };
  }

  const computed = compute(promo, input.cart);
  if (!computed.ok) return { valid: false, reason: computed.reason };
  const discountAmount = computed.amount;

  // Platform and region promo_eligibility rules first, as with any rule kind:
  // a tenant's own code can restrict further but never lift one.
  const context = {
    buyerRef: input.buyerRef,
    companyId: input.companyId ?? null,
    cart: input.cart,
    code: promo.code,
    now: now.toISOString(),
  };

  const platform = await evaluate(tx, {
    kind: 'promo_eligibility',
    tenantId: input.tenantId,
    region: null,
    context,
  });
  if (platform.denied && platform.byRule) {
    return {
      valid: false,
      reason: 'rule',
      rule: { id: platform.byRule.id, name: platform.byRule.name },
    };
  }

  if (promo.rules && deniedByOwnRule(promo, context)) {
    return { valid: false, reason: 'rule', rule: { id: promo.id, name: promo.code } };
  }

  const usage = await usageOf(tx, promo.id, input.buyerRef);

  if (promo.budget.maxUses !== undefined && usage.uses >= promo.budget.maxUses) {
    return { valid: false, reason: 'budget_uses' };
  }
  if (
    promo.budget.perBuyerMaxUses !== undefined &&
    usage.buyerUses >= promo.budget.perBuyerMaxUses
  ) {
    return { valid: false, reason: 'budget_buyer' };
  }
  if (promo.budget.maxSpend !== undefined && usage.spend + discountAmount > promo.budget.maxSpend) {
    return { valid: false, reason: 'budget_spend' };
  }

  return { valid: true, discountAmount, promocodeId: promo.id, lines: computed.lines };
}

/**
 * The code's own condition. Note the sense is the opposite of a rules-table
 * row: a platform `promo_eligibility` row denies when it matches, while a
 * code's own document says when the code MAY be used, so anything but true
 * denies. Both are documented in the README.
 */
function deniedByOwnRule(promo: PromocodeRow, context: Record<string, unknown>): boolean {
  try {
    return applyDocument(promo.rules, context) !== true;
  } catch (err) {
    // A broken condition on a code must not quietly hand out money.
    console.error(`promocodes: rule on ${promo.code} threw, treating as a deny`, err);
    return true;
  }
}

/** Reserved and settled both count against a budget; released does not. */
async function usageOf(
  tx: Tx,
  promocodeId: string,
  buyerRef: string,
): Promise<{ uses: number; buyerUses: number; spend: number }> {
  const [row] = await tx<{ uses: string; buyer_uses: string; spend: string }[]>`
    select
      count(*)::text as uses,
      count(*) filter (where buyer_ref = ${buyerRef})::text as buyer_uses,
      coalesce(sum(discount_amount), 0)::text as spend
    from redemptions
    where promocode_id = ${promocodeId} and status in ('reserved', 'settled')
  `;
  return {
    uses: Number(row?.uses ?? 0),
    buyerUses: Number(row?.buyer_uses ?? 0),
    spend: Number(row?.spend ?? 0),
  };
}

export type ReserveResult =
  | { reserved: true; redemption: RedemptionRow; lines: Line[] }
  | { reserved: false; reason: string; rule?: { id: string; name: string } };

/**
 * Hold the discount for an order. Locks the promocode row first, so two
 * checkouts racing for the last use of a code cannot both pass the budget.
 */
export async function reserve(
  tx: Tx,
  input: ValidateInput & { orderRef: string; ttlMinutes?: number | undefined },
): Promise<ReserveResult> {
  // One order, one redemption. A retry of the same checkout gets what the
  // first attempt produced rather than a second hold.
  const [existing] = await tx<RedemptionRow[]>`
    select * from redemptions
    where tenant_id = ${input.tenantId} and order_ref = ${input.orderRef}
  `;
  if (existing) {
    // The lines are the ones held, read back from the event that recorded
    // them, so a later change to the code or the cart cannot alter them. A
    // hold from before product lists has none recorded; its code covered
    // every item, so the held amount is split over all of them.
    const [held] = await tx<{ lines: Line[] | null }[]>`
      select payload->'lines' as lines from events
      where tenant_id = ${input.tenantId} and type = 'promo.reserved'
        and subject_type = 'redemption' and subject_id = ${existing.id}
    `;
    return {
      reserved: true,
      redemption: existing,
      lines: held?.lines ?? splitLines(Number(existing.discount_amount), input.cart.items),
    };
  }

  const verdict = await validate(tx, input, { lock: true });
  if (!verdict.valid) {
    return {
      reserved: false,
      reason: verdict.reason,
      ...(verdict.rule ? { rule: verdict.rule } : {}),
    };
  }

  const [promo] = await tx<PromocodeRow[]>`
    select * from promocodes where id = ${verdict.promocodeId}
  `;
  const ttl = input.ttlMinutes ?? env().RESERVATION_TTL_MINUTES;

  const [row] = await tx<RedemptionRow[]>`
    insert into redemptions
      (tenant_id, promocode_id, buyer_ref, company_id, order_ref, currency,
       discount_amount, status, expires_at)
    values (${input.tenantId}, ${verdict.promocodeId}, ${input.buyerRef},
            ${input.companyId ?? null}, ${input.orderRef}, ${input.cart.currency},
            ${verdict.discountAmount}, 'reserved',
            now() + (${ttl} || ' minutes')::interval)
    returning *
  `;
  if (!row) throw new Error('promocodes.reserve wrote no redemption');

  const ledger = activeLedger();
  const holds: Hold[] = [];
  for (const part of split(verdict.discountAmount, promo!.funders)) {
    const { holdRef } = await ledger.hold(tx, {
      tenantId: input.tenantId,
      redemptionId: row.id,
      party: part.party,
      currency: input.cart.currency,
      amount: part.amount,
    });
    holds.push({ party: part.party, holdRef, amount: part.amount });
  }

  const [withHolds] = await tx<RedemptionRow[]>`
    update redemptions set holds = ${tx.json(holds as never)} where id = ${row.id}
    returning *
  `;

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'promo.reserved',
    subjectType: 'redemption',
    subjectId: row.id,
    payload: {
      promocodeId: verdict.promocodeId,
      orderRef: input.orderRef,
      discountAmount: verdict.discountAmount,
      holds,
      lines: verdict.lines,
    },
  });

  return { reserved: true, redemption: withHolds!, lines: verdict.lines };
}

/**
 * The order completed. Captures what was actually used; anything reserved and
 * not used is released, so no hold is left open against an order that is done.
 */
export async function settle(
  tx: Tx,
  input: { tenantId: string; redemptionId: string; finalDiscountAmount?: number | undefined },
): Promise<RedemptionRow> {
  const redemption = await lockRedemption(tx, input.tenantId, input.redemptionId);
  if (redemption.status !== 'reserved') {
    throw new PromocodeError(
      'not_reserved',
      409,
      `redemption is ${redemption.status}, so it cannot be settled`,
    );
  }

  const reserved = Number(redemption.discount_amount);
  const final = input.finalDiscountAmount ?? reserved;
  if (!Number.isSafeInteger(final) || final < 0) {
    throw new PromocodeError('invalid_amount', 400, 'final discount must be a whole amount');
  }
  if (final > reserved) {
    throw new PromocodeError(
      'amount_above_reserved',
      422,
      `cannot settle ${final} against ${reserved} reserved`,
    );
  }

  const ledger = activeLedger();
  for (const part of proportion(final, redemption.holds)) {
    if (part.amount > 0) {
      await ledger.capture(tx, {
        tenantId: input.tenantId,
        redemptionId: redemption.id,
        holdRef: part.holdRef,
        amount: part.amount,
      });
    }
    // Whatever was held and not captured goes back, so nothing stays open.
    await ledger.release(tx, {
      tenantId: input.tenantId,
      redemptionId: redemption.id,
      holdRef: part.holdRef,
    });
  }

  const [row] = await tx<RedemptionRow[]>`
    update redemptions
    set status = 'settled', discount_amount = ${final}, settled_at = now()
    where id = ${redemption.id}
    returning *
  `;

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'promo.settled',
    subjectType: 'redemption',
    subjectId: redemption.id,
    payload: { reserved, settled: final, orderRef: redemption.order_ref },
  });

  return row!;
}

/** The order went away. A settled redemption is a refund question, not this one. */
export async function release(
  tx: Tx,
  input: { tenantId: string; redemptionId: string; reason: string },
): Promise<RedemptionRow> {
  const redemption = await lockRedemption(tx, input.tenantId, input.redemptionId);
  if (redemption.status !== 'reserved') {
    throw new PromocodeError(
      'not_reserved',
      409,
      `redemption is ${redemption.status}, so it cannot be released`,
    );
  }

  const ledger = activeLedger();
  for (const hold of redemption.holds) {
    await ledger.release(tx, {
      tenantId: input.tenantId,
      redemptionId: redemption.id,
      holdRef: hold.holdRef,
    });
  }

  const [row] = await tx<RedemptionRow[]>`
    update redemptions
    set status = 'released', released_at = now(), release_reason = ${input.reason}
    where id = ${redemption.id}
    returning *
  `;

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'promo.released',
    subjectType: 'redemption',
    subjectId: redemption.id,
    payload: { reason: input.reason, orderRef: redemption.order_ref },
  });

  return row!;
}

async function lockRedemption(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<RedemptionRow> {
  const [row] = await tx<RedemptionRow[]>`
    select * from redemptions where id = ${id} and tenant_id = ${tenantId} for update
  `;
  if (!row) throw new PromocodeError('not_found', 404, 'no such redemption');
  return row;
}

/**
 * Let go of reservations for orders that never completed. Runs as the owning
 * role on a schedule: a cart abandoned at checkout must not hold budget open
 * against every other buyer forever.
 */
export async function expireReservations(): Promise<number> {
  const due = await db()<{ id: string; tenant_id: string }[]>`
    select id, tenant_id from redemptions
    where status = 'reserved' and expires_at <= now()
  `;

  let released = 0;
  for (const row of due) {
    try {
      await db().begin((tx) =>
        release(tx as Tx, {
          tenantId: row.tenant_id,
          redemptionId: row.id,
          reason: 'expired',
        }),
      );
      released += 1;
    } catch (err) {
      // One stuck reservation must not stop the rest being freed.
      console.error(`promocodes: could not expire redemption ${row.id}`, err);
    }
  }
  return released;
}

export type Reconciliation = {
  currency: string;
  settled: { redemptions: number; ledger: number; agrees: boolean };
  outstanding: { redemptions: number; ledger: number; agrees: boolean };
};

/**
 * Spend equals settlement, or it says so. For each currency: what the
 * redemptions say was settled must equal what the ledger captured, and what
 * they say is still reserved must equal what the ledger is still holding.
 */
export async function reconcile(tx: Tx, tenantId: string): Promise<Reconciliation[]> {
  const ledger = activeLedger();

  const rows = await tx<{ currency: string; status: string; total: string }[]>`
    select currency, status, coalesce(sum(discount_amount), 0)::text as total
    from redemptions
    where tenant_id = ${tenantId}
    group by currency, status
  `;

  // Parties come from the codes themselves, so the ledger's store stays hidden
  // behind its interface.
  const codes = await tx<{ currency: string; funders: Funder[] }[]>`
    select currency, funders from promocodes where tenant_id = ${tenantId}
  `;

  const currencies = [...new Set([...rows, ...codes].map((r) => r.currency))];
  const result: Reconciliation[] = [];

  for (const currency of currencies) {
    const parties = [
      ...new Set(
        codes.filter((c) => c.currency === currency).flatMap((c) => c.funders.map((f) => f.party)),
      ),
    ];

    let held = 0;
    let captured = 0;
    let releasedTotal = 0;
    for (const party of parties) {
      const balance = await ledger.balance(tx, { tenantId, party, currency });
      held += balance.held;
      captured += balance.captured;
      releasedTotal += balance.released;
    }

    const sum = (status: string) =>
      Number(rows.find((r) => r.currency === currency && r.status === status)?.total ?? 0);

    const settled = sum('settled');
    const reserved = sum('reserved');
    const outstanding = held - captured - releasedTotal;

    result.push({
      currency,
      settled: { redemptions: settled, ledger: captured, agrees: settled === captured },
      outstanding: {
        redemptions: reserved,
        ledger: outstanding,
        agrees: reserved === outstanding,
      },
    });
  }

  return result;
}
