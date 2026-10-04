# Brief 14 — Promocodes in the operator view

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. Today an operator can see redemptions, each one use of a code, but not the codes themselves: discount, budget, funders, rules, validity and how much of the budget is gone live only behind a tenant's own `GET /v1/promocodes`. This brief adds the read side for codes and a dashboard view over it. It adds no promocode behaviour.

Rule 9 decides the split: every number and state the screen shows is computed by the engine and arrives as a field. The dashboard formats; it does not add, subtract or compare.

## Part A — the API

### `GET /internal/promocodes?tenantId&status&code&limit&cursor`
Newest first by `created_at`, cursor by id, as every operator list. `status` is the stored status; `code` is a case-insensitive prefix. Each row:

- Every column of the code: `id`, `tenantId`, `tenantName`, `code`, `currency`, `discount`, `rules`, `budget`, `funders`, `startsAt`, `endsAt`, `status`, `createdAt`, `updatedAt`.
- `usage`, computed in one query from `redemptions`:
  - `uses` and `spend`: count and discount sum of `reserved` + `settled`, the same numbers `validate` checks the budget against.
  - `reserved`, `settled`, `released`: `{ count, amount }` each.
  - `buyers`: distinct `buyer_ref` over `reserved` + `settled`.
  - `remainingUses`, `remainingSpend`: `budget.maxUses - uses` and `budget.maxSpend - spend`, never below 0; `null` when that budget is unset.
  - `lastRedeemedAt`: the latest `reserved_at`, or `null`.
- `availability`: one of `paused`, `ended`, `scheduled` (`starts_at` in the future), `expired` (`ends_at` passed), `exhausted` (`uses >= maxUses` or `spend >= maxSpend`), `live`. First match in that order wins. It is a pure function `availability(promo, usage, now)` exported from the promocodes module, so the order sits next to `validate` and not in SQL or the browser. `live` does not promise every cart validates: per-buyer limits, `minSubtotal` and rules still apply.

Amounts are integers in minor units, like everywhere else.

### `GET /internal/promocodes/:id`
`{ promocode }`, the same row shape. `404` if unknown or not a uuid. The code's redemptions come from the existing feed, `GET /internal/redemptions?promocodeId=`.

### Redemptions feed
Each row gains `promocodeId`, so a redemption links to its code.

## Part B — the dashboard

- **`#/promocodes`**, in the nav after Campaigns: the list, with filters for tenant id, status and code. Columns: code, tenant, discount, availability, uses (of `maxUses`), spend (of `maxSpend`), valid from–to, last redeemed. A row opens the detail.
- **`#/promocodes/:id`**: cards for the code (tenant link, currency, discount, stored status and availability, validity, created, updated), budget and usage (every `usage` field and the three budget limits), funders (party and share), and the rules document as JSON, `none` when null. Below them, the code's redemptions from the feed with `promocodeId` and `since` set to the code's `createdAt`, so the feed's default 30-day window does not hide older ones; paged like every list.
- **Tenant detail**: a `promocodes` tab next to `redemptions`. In the redemptions tab, a redemption's code links to `#/promocodes/:promocodeId`.
- `format.ts` gains `discount(d, currency)`: `10%` for a percent of 1000 basis points, money for a fixed one, with `up to` and `min subtotal` when set. Formatting only.

## Tests
Engine (`test/operator.test.ts`, a `promocodes` describe):
1. Tenant A: a code with `maxUses 3`, `maxSpend 20000`; three reservations, one settled, one released, one still reserved. Its row has `uses 2`, `spend` equal to the two amounts, `reserved`/`settled`/`released` counts and amounts as seeded, `remainingUses 1`, `buyers` as seeded, `availability live`.
2. A paused code → `paused`; a code with `endsAt` in the past → `expired`; one with `startsAt` in the future → `scheduled`; one at `maxUses` → `exhausted`; a code with no budget → `remainingUses` and `remainingSpend` null.
3. `tenantId`, `status` and `code` filter; two pages with `limit` have no gap or repeat; tenant B's code appears unfiltered with `tenantName`.
4. Detail returns the same row; unknown id and a non-uuid → `404`. A tenant JWT → `401`.
5. A redemptions feed row carries `promocodeId`.

Unit (`test/promocodes.test.ts`): `availability` order, e.g. a paused code past its `endsAt` is `paused`, an expired code at `maxUses` is `expired`.

Dashboard (`dashboard/test/`): both views render from a fixture, and their empty and error states; `discount()` formats percent, fixed, `maxDiscount` and `minSubtotal`.

## Done when
CI passes; `docs/API.md` and `docs/DASHBOARD.md` describe the two routes and the field; row 14 in the roadmap in `docs/ARCHITECTURE.md`.

## Do not
- Add any write: no pause, edit or create from the dashboard. Clients change codes through `/v1`.
- Compute anything in the browser beyond formatting.
- Add per-funder amounts. The ledger holds those, and reconciliation is tenant-scoped through `/v1/promocodes/reconcile`; a funder breakdown is a separate brief if an operator asks for it.
- Add a migration. The existing indexes serve these queries at today's volume.
