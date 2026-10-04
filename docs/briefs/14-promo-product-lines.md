# Brief 14 — Promocodes limited to products, with a discount per line

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This is the engine's part (E1–E3) of the supplier promo-codes design (`promo-codes-design.md`, D3, D13, Part A, Part E2): a supplier's code can be limited to some of its products, and checkout needs to know what comes off each line, because only those lines are lowered on the order. Codes without a product list behave exactly as before.

Amounts stay whole minor units. Corporate sends each cart line as `qty: 1`, `unitPrice: <line total>`, `sku: <product id>` (D13).

## Part A — the product list (E1)
`discount.productIds?: string[]` on `POST /v1/promocodes`: uuids, at most 500. Stored in the existing `discount` JSON; no migration.
- `PATCH /v1/promocodes/:id` takes `status`, `discount.productIds`, or both (at least one). Only the list changes; the discount's type and amounts never do. An empty list lifts the limit.

## Part B — compute (E2)
`compute(promo, cart)` in `modules/promocodes/money.ts`, still pure:
- No list (absent or empty): the amount comes from `cart.subtotal`, as before.
- With a list: eligible lines are the items whose `sku` is on it (any letter case); the eligible subtotal is Σ `qty × unitPrice` of those lines. `minSubtotal`, the percent or fixed amount, `maxDiscount` and the cap all work on that subtotal.
- A list with nothing in the cart on it → `{ ok: false, reason: 'no_eligible_items' }`, checked after `currency_mismatch` and before `min_subtotal`.
- Every success returns `lines`, one per item: each eligible line's share by value, rounded down, with the remainder on the first eligible line, so they sum exactly to the amount. A line is never discounted below zero: remainder it cannot take moves to the next eligible line.

## Part C — lines on validate and hold (E3)
- `POST /v1/promocodes/validate` → `{ valid: true, discountAmount, promocodeId, lines: [{ index, sku, amount }] }`, one entry per item in the order sent, `amount: 0` for lines not discounted.
- `POST /v1/redemptions` → `201 { redemption, lines }`. The lines go into the `promo.reserved` payload. The same `Idempotency-Key` replays the stored response; the same `orderRef` under a new key returns the lines read back from that event, never recomputed from a changed code or cart.
- A cart whose items add up past `Number.MAX_SAFE_INTEGER` is a `400`.

## Tests, CI
- `test/money.test.ts`: no list = old behaviour; percent, fixed, `maxDiscount`, `minSubtotal` on the eligible subtotal; `no_eligible_items`; remainder on the first eligible line; sums exact and every line in `[0, value]` over 300 generated carts; amounts past 2^53.
- `test/promocodes.test.ts`: create and patch the list; validate returns lines; `no_eligible_items` on validate and hold; hold returns the validate lines, a same-key retry replays them byte for byte, and a new key after the list and cart changed still returns the held lines.

## Done when
CI passes; `docs/API.md` covers `productIds`, `lines` and `no_eligible_items`; staging smoke (E4): a product-limited code validates, holds, replays, settles and releases on staging; row 14 in the roadmap in `docs/ARCHITECTURE.md`.

## Do not
- Add a table or a migration. The list lives in `discount`, the held lines in the event log.
- Limit by category. Categories differ between the supplier and corporate databases (design §5 O4).
- Change anything for a code without a list.
