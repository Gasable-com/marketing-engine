# Brief 16 — The buyer's company on a redemption

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. On staging, checkout sent the marketplace's own company id as `companyId`. `companyId` is a registry id, the registry holds off-platform companies only, and marketplace members are not mirrored into it, so the id was unknown: validate said yes, and reserve died on the `redemptions.company_id` foreign key with a 500. The marketplace still needs to know which of its companies used which code, so this brief gives that its own field and turns an unknown `companyId` into an answer instead of a crash.

## The field
`buyerCompanyRef`: an optional string, at most 200 characters, the marketplace's own id for the buying company. Opaque, like `buyerRef`: the engine stores it and never looks it up.

- Accepted on `POST /v1/promocodes/validate` and `POST /v1/redemptions`.
- In the rule context as `buyerCompanyRef`, next to `buyerRef` and `companyId`, so a code's own document can name companies by the marketplace's ids.
- Migration `0015_buyer_company_ref.sql`: `redemptions.buyer_company_ref text null`. Reserve writes it.
- `promo.reserved`, `promo.settled` and `promo.released` carry `buyerRef` and `buyerCompanyRef` (null when not sent) in their payloads, so the event log and webhooks say who on every step.
- `GET /internal/redemptions` rows gain `buyerCompanyRef`. The dashboard shows it under the buyer in a code's redemptions and in the tenant's redemptions tab.

## Unknown `companyId`
`validate` resolves a sent `companyId` through `registry.resolve`. Unknown: `{ valid: false, reason: "unknown_company" }`, checked right after `not_found`. Reserve inherits it, so it answers `200 { valid: false, reason: "unknown_company" }` and never reaches the insert.

## Tests (`test/promocodes.test.ts`)
1. Validate and reserve with `buyerCompanyRef`: the redemption row stores it; `promo.reserved`, then `promo.settled` (and on a second order `promo.released`) carry it and `buyerRef`.
2. A code whose own rule is `{"==":[{"var":"buyerCompanyRef"},"co-1"]}` validates for `co-1` and refuses `co-2` with `rule`.
3. An unknown `companyId` gives `unknown_company` on validate and on reserve, a `200`, with no redemption written. A registry company's id still reserves and is stored.
4. The redemptions feed row carries `buyerCompanyRef` (`test/operator.test.ts`).

## Done when
CI passes; `docs/API.md` lists the field, the reason and the payloads; row 16 in the roadmap.

## Do not
- Put marketplace companies in the registry, or create a company from an unknown id.
- Drop or loosen the foreign key on `company_id`.
- Validate `buyerCompanyRef` against anything.
