/**
 * Money is integers in the currency's minor unit. Nothing here is ever a
 * float, and no discount is ever lost or invented by rounding: a split that
 * does not divide evenly puts the remainder on the first funder.
 */

export type Discount = {
  type: 'percent' | 'fixed';
  /** Basis points for percent (1000 = 10%), minor units for fixed. */
  value: number;
  maxDiscount?: number | undefined;
  minSubtotal?: number | undefined;
  /**
   * Limits the code to these products, matched against each item's `sku`.
   * Absent or empty: every item, and the code reads `cart.subtotal` as it
   * always has.
   */
  productIds?: string[] | undefined;
};

export type Cart = {
  currency: string;
  subtotal: number;
  items: {
    sku?: string | undefined;
    category?: string | undefined;
    qty: number;
    unitPrice: number;
  }[];
};

export type Funder = { party: string; share: number };

/** One entry per cart item, in cart order: what this code takes off that line. */
export type Line = { index: number; sku: string | null; amount: number };

export type ComputeResult =
  | { ok: true; amount: number; lines: Line[] }
  | { ok: false; reason: 'currency_mismatch' | 'min_subtotal' | 'no_eligible_items' };

const BASIS_POINTS = 10_000;

/** Pure: what this code is worth against this cart, or why it is worth nothing. */
export function compute(
  promo: { currency: string; discount: Discount },
  cart: Cart,
): ComputeResult {
  if (promo.currency !== cart.currency) return { ok: false, reason: 'currency_mismatch' };

  const limited = (promo.discount.productIds?.length ?? 0) > 0;
  const values = eligibleValues(promo.discount, cart.items);
  if (limited && values.every((v) => v === null)) {
    return { ok: false, reason: 'no_eligible_items' };
  }

  // A code limited to products is worth what those lines are worth. One that
  // is not reads the cart's own subtotal, exactly as before product lists.
  const subtotal = limited ? values.reduce<number>((sum, v) => sum + (v ?? 0), 0) : cart.subtotal;

  if (promo.discount.minSubtotal && subtotal < promo.discount.minSubtotal) {
    return { ok: false, reason: 'min_subtotal' };
  }

  const raw =
    promo.discount.type === 'percent'
      ? Math.floor((subtotal * promo.discount.value) / BASIS_POINTS)
      : promo.discount.value;

  let amount = raw;
  if (promo.discount.maxDiscount !== undefined) {
    amount = Math.min(amount, promo.discount.maxDiscount);
  }
  // A discount can never exceed the cart it is discounting.
  amount = Math.min(amount, subtotal);
  amount = Math.max(0, Math.floor(amount));

  return { ok: true, amount, lines: allocate(amount, cart.items, values) };
}

/**
 * Split an amount that is already decided across every line of a cart, as
 * `compute` does for a code without a product list.
 */
export function splitLines(amount: number, items: Cart['items']): Line[] {
  return allocate(amount, items, items.map((item) => item.qty * item.unitPrice));
}

/** Each item's value (qty × unitPrice), or null when the code does not cover it. */
function eligibleValues(discount: Discount, items: Cart['items']): (number | null)[] {
  const only = discount.productIds?.length
    ? new Set(discount.productIds.map((id) => id.toLowerCase()))
    : null;
  return items.map((item) =>
    !only || (item.sku !== undefined && only.has(item.sku.toLowerCase()))
      ? item.qty * item.unitPrice
      : null,
  );
}

/**
 * Split by line value. Each eligible line gets its share rounded down and the
 * remainder goes on the first eligible line, so the parts sum to exactly the
 * amount. A line is never discounted below zero: remainder it cannot take
 * moves on to the next eligible line.
 */
function allocate(amount: number, items: Cart['items'], values: (number | null)[]): Line[] {
  const total = values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  // BigInt: amount × value can pass 2^53 on a large order.
  const parts = values.map((v) =>
    v === null || total === 0 ? 0 : Number((BigInt(amount) * BigInt(v)) / BigInt(total)),
  );

  let rest = amount - parts.reduce((sum, p) => sum + p, 0);
  for (let i = 0; i < values.length && rest > 0; i += 1) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    const take = Math.min(rest, v - parts[i]!);
    parts[i]! += take;
    rest -= take;
  }
  // Only an amount bigger than the eligible lines are worth gets here: a code
  // without a product list on a cart whose items add up to less than its
  // subtotal. The sum still has to be exact.
  const first = values.findIndex((v) => v !== null);
  if (rest > 0 && first !== -1) parts[first]! += rest;

  return items.map((item, index) => ({ index, sku: item.sku ?? null, amount: parts[index]! }));
}

/**
 * Split an amount between funders by share. Each part is rounded, and whatever
 * the rounding left over goes on the first funder, so the parts always sum to
 * exactly the amount.
 */
export function split(amount: number, funders: Funder[]): { party: string; amount: number }[] {
  if (funders.length === 0) throw new Error('a promocode needs at least one funder');

  const parts = funders.map((f) => ({ party: f.party, amount: Math.round(amount * f.share) }));
  const drift = amount - parts.reduce((sum, p) => sum + p.amount, 0);
  parts[0]!.amount += drift;

  return parts;
}

/** Split a settlement across holds in proportion to what each one is holding. */
export function proportion(
  total: number,
  holds: { holdRef: string; amount: number }[],
): { holdRef: string; amount: number }[] {
  const held = holds.reduce((sum, h) => sum + h.amount, 0);
  if (held === 0) return holds.map((h) => ({ holdRef: h.holdRef, amount: 0 }));

  const parts = holds.map((h) => ({
    holdRef: h.holdRef,
    amount: Math.round((total * h.amount) / held),
  }));
  const drift = total - parts.reduce((sum, p) => sum + p.amount, 0);
  parts[0]!.amount += drift;

  return parts;
}

export function fundersAreValid(funders: Funder[]): boolean {
  if (funders.length === 0) return false;
  if (funders.some((f) => !f.party || f.share < 0 || f.share > 1)) return false;
  const total = funders.reduce((sum, f) => sum + f.share, 0);
  return Math.abs(total - 1) < 1e-6;
}
