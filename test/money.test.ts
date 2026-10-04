import { describe, expect, it } from 'vitest';
import { compute, splitLines, type Cart, type Discount } from '../src/modules/promocodes/money.js';

const DIESEL = '11111111-1111-4111-8111-111111111111';
const GAS = '22222222-2222-4222-8222-222222222222';
const OIL = '33333333-3333-4333-8333-333333333333';

/** Each line as D13 sends it: one unit at the line's value. */
function cartOf(lines: [sku: string | undefined, value: number][], subtotal?: number): Cart {
  return {
    currency: 'SAR',
    subtotal: subtotal ?? lines.reduce((sum, [, v]) => sum + v, 0),
    items: lines.map(([sku, value]) => ({ ...(sku ? { sku } : {}), qty: 1, unitPrice: value })),
  };
}

const promo = (discount: Discount, currency = 'SAR') => ({ currency, discount });
const percent = (value: number, extra: Partial<Discount> = {}): Discount => ({
  type: 'percent',
  value,
  ...extra,
});
const fixed = (value: number, extra: Partial<Discount> = {}): Discount => ({
  type: 'fixed',
  value,
  ...extra,
});

const amounts = (result: ReturnType<typeof compute>) =>
  result.ok ? result.lines.map((l) => l.amount) : null;

describe('compute without a product list', () => {
  it('works the amount off cart.subtotal as before, not the items', () => {
    // The items add up to 50000; the cart says 80000. The old rule reads 80000.
    const cart = cartOf([[DIESEL, 50000]], 80000);
    expect(compute(promo(percent(1000)), cart)).toMatchObject({ ok: true, amount: 8000 });
    expect(compute(promo(percent(1000, { maxDiscount: 5000 })), cart)).toMatchObject({
      ok: true,
      amount: 5000,
    });
    expect(compute(promo(fixed(90000)), cart)).toMatchObject({ ok: true, amount: 80000 });
    expect(compute(promo(percent(1000, { minSubtotal: 60000 })), cart)).toMatchObject({ ok: true });
    expect(compute(promo(percent(1000, { minSubtotal: 90000 })), cart)).toEqual({
      ok: false,
      reason: 'min_subtotal',
    });
  });

  it('treats an empty list the same as no list', () => {
    const cart = cartOf([[DIESEL, 30000], [GAS, 10000]]);
    expect(compute(promo(percent(1000, { productIds: [] })), cart)).toEqual(
      compute(promo(percent(1000)), cart),
    );
  });

  it('still answers for a cart with no items, with no lines', () => {
    const cart: Cart = { currency: 'SAR', subtotal: 80000, items: [] };
    expect(compute(promo(percent(1000)), cart)).toEqual({ ok: true, amount: 8000, lines: [] });
  });

  it('splits the amount over every line by value', () => {
    const result = compute(promo(percent(1000)), cartOf([[DIESEL, 30000], [GAS, 10000]]));
    expect(result).toEqual({
      ok: true,
      amount: 4000,
      lines: [
        { index: 0, sku: DIESEL, amount: 3000 },
        { index: 1, sku: GAS, amount: 1000 },
      ],
    });
  });

  it('keeps the sum exact when the items are worth less than the subtotal', () => {
    const result = compute(promo(fixed(70000)), cartOf([[DIESEL, 30000], [GAS, 10000]], 80000));
    expect(result).toMatchObject({ ok: true, amount: 70000 });
    expect(amounts(result)!.reduce((a, b) => a + b, 0)).toBe(70000);
  });

  it('refuses a cart in another currency before anything else', () => {
    const usd = promo(percent(1000, { productIds: [OIL] }), 'USD');
    expect(compute(usd, cartOf([[DIESEL, 100]]))).toEqual({
      ok: false,
      reason: 'currency_mismatch',
    });
  });
});

describe('compute with a product list', () => {
  const cart = cartOf([[GAS, 20000], [DIESEL, 100000], [OIL, 5000]]);

  it('takes a percent off the listed lines only', () => {
    const result = compute(promo(percent(1000, { productIds: [DIESEL] })), cart);
    expect(result).toEqual({
      ok: true,
      amount: 10000,
      lines: [
        { index: 0, sku: GAS, amount: 0 },
        { index: 1, sku: DIESEL, amount: 10000 },
        { index: 2, sku: OIL, amount: 0 },
      ],
    });
  });

  it('shares a fixed amount across the listed lines by value', () => {
    const result = compute(promo(fixed(2100, { productIds: [DIESEL, OIL] })), cart);
    expect(result).toMatchObject({ ok: true, amount: 2100 });
    expect(amounts(result)).toEqual([0, 2000, 100]);
  });

  it('caps by maxDiscount and by the eligible subtotal, not the cart', () => {
    const halfOffOil = percent(5000, { productIds: [OIL], maxDiscount: 1000 });
    expect(compute(promo(halfOffOil), cart)).toMatchObject({ ok: true, amount: 1000 });
    // 50000 off a cart of 125000 would fit, but the oil line is worth 5000.
    const capped = compute(promo(fixed(50000, { productIds: [OIL] })), cart);
    expect(capped).toMatchObject({ ok: true, amount: 5000 });
    expect(amounts(capped)).toEqual([0, 0, 5000]);
  });

  it('checks minSubtotal against the eligible lines', () => {
    // The cart is 125000, the gas line 20000.
    const gasFrom = (minSubtotal: number) =>
      promo(percent(1000, { productIds: [GAS], minSubtotal }));
    expect(compute(gasFrom(50000), cart)).toEqual({ ok: false, reason: 'min_subtotal' });
    expect(compute(gasFrom(20000), cart)).toMatchObject({ ok: true, amount: 2000 });
  });

  it('refuses a cart with nothing on the list', () => {
    const elsewhere = '44444444-4444-4444-8444-444444444444';
    const notHere = promo(percent(1000, { productIds: [elsewhere], minSubtotal: 1 }));
    const refused = { ok: false, reason: 'no_eligible_items' };
    expect(compute(notHere, cart)).toEqual(refused);
    expect(compute(notHere, { ...cart, items: [] })).toEqual(refused);
  });

  it('never matches a line that has no sku', () => {
    const result = compute(
      promo(percent(1000, { productIds: [DIESEL] })),
      cartOf([[undefined, 9000], [DIESEL, 1000]]),
    );
    expect(result).toEqual({
      ok: true,
      amount: 100,
      lines: [
        { index: 0, sku: null, amount: 0 },
        { index: 1, sku: DIESEL, amount: 100 },
      ],
    });
  });

  it('matches product ids whatever their letter case', () => {
    const result = compute(promo(percent(1000, { productIds: [DIESEL.toUpperCase()] })), cart);
    expect(amounts(result)).toEqual([0, 10000, 0]);
  });

  it('counts qty × unitPrice as the line value', () => {
    const result = compute(promo(percent(1000, { productIds: [DIESEL] })), {
      currency: 'SAR',
      subtotal: 999999,
      items: [{ sku: DIESEL, qty: 3, unitPrice: 2500 }],
    });
    expect(result).toMatchObject({ ok: true, amount: 750, lines: [{ amount: 750 }] });
  });
});

describe('rounding', () => {
  it('puts the remainder on the first eligible line', () => {
    const thirds = cartOf([[GAS, 100], [DIESEL, 100], [OIL, 100]]);
    expect(amounts(compute(promo(fixed(200)), thirds))).toEqual([68, 66, 66]);
    // The first line is not on the list, so the first eligible one takes it.
    expect(
      amounts(
        compute(
          promo(fixed(200, { productIds: [DIESEL, OIL] })),
          cartOf([[GAS, 100], [DIESEL, 100], [OIL, 100], [GAS, 50]]),
        ),
      ),
    ).toEqual([0, 100, 100, 0]);
    expect(
      amounts(
        compute(
          promo(fixed(100, { productIds: [DIESEL, OIL] })),
          cartOf([[GAS, 100], [DIESEL, 100], [OIL, 100], [OIL, 100]]),
        ),
      ),
    ).toEqual([0, 34, 33, 33]);
  });

  it('never takes a line below zero, even when the first line is tiny', () => {
    // Seven lines worth 1 and 3 to share: floor gives 0 each, and the first
    // line can only take 1 of the 3.
    const ones = Array.from({ length: 7 }, () => [DIESEL, 1] as [string, number]);
    expect(amounts(compute(promo(fixed(3)), cartOf(ones)))).toEqual([1, 1, 1, 0, 0, 0, 0]);
  });

  it('sums exactly, inside every line, on awkward carts', () => {
    const skus = [DIESEL, GAS, OIL];
    for (let seed = 1; seed <= 300; seed += 1) {
      // Some lines are worth 0, and one line of 1 is common.
      const lines = Array.from({ length: 1 + (seed % 9) }, (_, i): [string, number] => [
        skus[(seed + i) % 3]!,
        ((seed * 7919 + i * 104729) % 9973) + (i % 4 === 0 ? 0 : 1),
      ]);
      const discount =
        seed % 2 === 0
          ? percent((seed * 37) % 10001, { productIds: [DIESEL, OIL] })
          : fixed((seed * 1237) % 40000, { productIds: seed % 3 === 0 ? [] : [GAS] });
      const result = compute(promo(discount), cartOf(lines));
      if (!result.ok) {
        expect(result.reason).toBe('no_eligible_items');
        continue;
      }

      expect(result.lines).toHaveLength(lines.length);
      expect(result.lines.reduce((sum, l) => sum + l.amount, 0)).toBe(result.amount);
      result.lines.forEach((line, i) => {
        expect(line.index).toBe(i);
        expect(Number.isInteger(line.amount)).toBe(true);
        expect(line.amount).toBeGreaterThanOrEqual(0);
        expect(line.amount).toBeLessThanOrEqual(lines[i]![1]);
        if (discount.productIds?.length && !discount.productIds.includes(lines[i]![0])) {
          expect(line.amount).toBe(0);
        }
      });
    }
  });

  it('stays exact on an order too large for float arithmetic', () => {
    // amount × value is past 2^53 here.
    const big = 4_000_000_000_000;
    const result = compute(promo(percent(3333)), cartOf([[DIESEL, big], [GAS, big + 7], [OIL, 3]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.reduce((sum, l) => sum + l.amount, 0)).toBe(result.amount);
    expect(result.lines[2]!.amount).toBe(0);
  });
});

describe('splitLines', () => {
  it('splits as compute does for a code without a product list', () => {
    const cart = cartOf([[GAS, 777], [DIESEL, 12345], [OIL, 999]]);
    const result = compute(promo(fixed(1001)), cart);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(splitLines(result.amount, cart.items)).toEqual(result.lines);
  });
});
