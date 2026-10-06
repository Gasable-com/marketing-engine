# Brief 15 — Describe promocodes, read-only

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. The corporate checkout keeps a "Your promo codes" vault: codes a company used or saved, drawn as tickets. Validate says whether a code works on a cart and for how much, but never what the code is, so a ticket cannot say "10% off", "minimum SAR 500", "ends 12 Nov", "only these products" or "last use". This brief adds one read-only batch call that does.

## The call
`POST /v1/promocodes/describe`, tenant JWT, no `Idempotency-Key` needed.

```json
{ "codes": ["WELCOME5", "NOPE"], "buyerRef": "<auth user id>", "at": "…" }
```

`codes`: 1 to 20. `at` (optional) is as on validate.

→ `200 { "codes": [ … ] }`, one entry per code, in the order sent, `code` as sent:
- Unknown: `{ "code": "NOPE", "found": false }`.
- Known: `{ code, found: true, status, kind, percentBps, amount, currency, maxDiscount, minSubtotal, skus, startsAt, endsAt, usesLeftForBuyer }`.
  - `status`, first true one wins: `paused` or `ended` (the code's own status); `ended` (`endsAt` passed); `scheduled` (`startsAt` not reached); `exhausted` (`maxUses` reached, or `maxSpend` used up); `active`.
  - `kind` is `percent` or `fixed`; `percentBps` for percent, `amount` (minor units) for fixed, the other `null`.
  - `maxDiscount`, `minSubtotal`: minor units or `null`. `skus`: the product list, `[]` for every product.
  - `usesLeftForBuyer`: `perBuyerMaxUses` minus this `buyerRef`'s reserved and settled uses, never below 0; `null` without a per-buyer limit.

Reads only: no counters, no holds, no events. Codes match in any letter case, as on validate.

## Tests
`test/promocodes.test.ts`: order and `found: false` kept; percent and fixed fields; each status; `usesLeftForBuyer` drops after a hold, comes back after a release, `null` without a limit; nothing written (no redemptions, no events); 21 codes is a `400`; tenant B cannot see tenant A's codes.

## Done when
CI passes; `docs/API.md` covers the call; row 15 in the roadmap in `docs/ARCHITECTURE.md`.

## Do not
- Evaluate the code's own `rules` here. A condition can depend on the cart, which this call does not have; validate stays the answer to "does it work on this cart". Validate already tells a buyer a code exists (`reason: rule`), so hiding such codes here would protect nothing.
- Add an `audience` field. There is no targeting yet; it comes with company targeting.
