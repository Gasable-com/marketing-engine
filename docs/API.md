# marketing-engine API

Every route the engine serves. Hand-written, so if something here is wrong it is
a bug in this file — say so.

## Conventions

- **Money is an integer in the currency's minor unit.** Halalas for SAR. Never
  a float, never a major unit. `80000` is 800.00 SAR.
- **A percent discount is basis points.** `1000` is 10%.
- **Phone numbers are E.164** (`+9665…`). Send a national number only with
  `defaultCountry` beside it (ISO 3166-1 alpha-2), or it is rejected.
- **`Idempotency-Key` is required** on `POST /v1/redemptions` and the settle and
  release routes, and accepted everywhere else. The same key with a different
  body is a 422, not a replay.
- **Timestamps are ISO 8601 UTC.** IDs are UUIDs unless stated.
- Errors are `{ "error": "<code>", "message": "<human text>" }`. Validation
  failures add `detail` with the offending fields.

## Authentication

Three kinds, and a route takes exactly one.

**Tenant JWT** — `Authorization: Bearer <jwt>` on everything under `/v1`. The
marketplace mints these itself with the shared `JWT_SECRET`; the engine never
issues a token. HS256, and the only claim the engine reads is `tenant_id`:

```ts
import { SignJWT } from 'jose';

const token = await new SignJWT({ tenant_id: tenantId, sub: externalRef })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('15m')
  .sign(new TextEncoder().encode(process.env.JWT_SECRET));
```

**Internal token** — `X-Internal-Token: <INTERNAL_TOKEN>` on `/internal/*`.
The marketplace's own key. These calls create the tenants that JWTs name, so
they cannot be scoped by one.

**None** — the public routes carry their own secret in the URL or the body.

---

## Tenants

### `POST /internal/tenants` — internal token

Provision a tenant. Idempotent on `externalRef`: asking twice returns the same
tenant, because the marketplace will retry.

```json
{ "name": "Acme Supplies", "externalRef": "mkt-company-1" }
```

→ `201 { "tenantId": "<uuid>", "name": "Acme Supplies" }` on the first call,
`200` with the same body afterwards. Emits `tenant.created`.

Errors: `400` invalid body, `401` wrong token.

---

## Channels

### `PUT /v1/channels/:channel` — tenant JWT

`:channel` is `sms`, `whatsapp`, `email` or `telegram`. The credentials are
checked against the provider before they are stored, and encrypted at rest.

```json
{
  "provider": "taqnyat",
  "sender": "GASABLE-AD",
  "unsubscribeText": "Reply STOP to unsubscribe",
  "config": { "token": "…" }
}
```

`config` keys by provider:

| provider | channel | keys |
| --- | --- | --- |
| `taqnyat` | sms | `token`, `baseUrl?` |
| `whatsapp-meta` | whatsapp | `accessToken`, `phoneNumberId`, `appSecret`, `apiVersion?` |
| `email-smtp` | email | `host`, `port`, `secure`, `user`, `pass`, `fromName?` |
| `telegram` | telegram | `botToken` |
| `fake` | all four | `token` (the value `"bad"` fails validation) |

→ `200 { "channel": { channel, provider, sender, unsubscribeText, configured, updatedAt } }`.
The credentials are never echoed. Emits `channel.configured`.

Errors: `400` invalid body, `422` `credentials_rejected` / `unknown_provider`.

### `GET /v1/channels/:channel` — tenant JWT

→ `200` with the same redacted shape, or `404`.

---

## Templates

### `PUT /v1/templates/:name` — tenant JWT

Liquid, rendered with `strictVariables`, so a missing variable is a 400 naming
it rather than an empty string sent to a real person.

```json
{
  "channel": "whatsapp",
  "body": "Hi {{ name }}",
  "subject": "Hello {{ name }}",
  "providerRef": { "name": "greet", "language": "ar", "params": ["name"] }
}
```

`subject` is required for `email`. `providerRef` is required for `whatsapp` and
names the Meta-approved template plus the order its positional parameters are
filled — Meta does not accept free text for business-initiated messages. A
template missing what its channel needs is `template_unfit`.

→ `200 { "template": { name, channel, body } }`. Emits `template.saved`.

Errors: `400` `template_invalid` (the Liquid does not parse).

---

## Messages

### `POST /v1/messages` — tenant JWT, `Idempotency-Key` accepted

An intent, not a channel command.

```json
{
  "contact": { "phone": "+9665…", "email": "a@b.co", "telegram": "123456789" },
  "channel": "whatsapp",
  "purpose": "marketing",
  "template": "order_update",
  "variables": { "order": "A-1043" },
  "defaultCountry": "SA",
  "evaluateAt": "2026-09-21T10:00:00Z"
}
```

Name a `channel` and that is the channel. Leave it out and the engine picks: it
asks suppression and consent of every channel the contact has both an address
and a configured provider for, lets a `channel_selection` rule order what is
left, and applies the sending window to the one it picks. The rest become the
fallback order. `evaluateAt` pins the clock the sending window and rules are
checked against, for testing. **It does not delay the send**: the message is
queued now either way. To send later, use a campaign.

`at` is the deprecated name for `evaluateAt`, accepted for one release and then
removed. When both are given, `evaluateAt` wins.

The older `{ "channel", "address" }` pair is still accepted and folded into a
contact. It will be removed.

→ `202 { "message": … }` when queued, `200` when `can_send` refused — a refusal
is an answer, not an error. The message carries `status`, `blockedReason`,
`fallbackChannels`, `parentMessageId` and the rendered `body`.

Statuses: `blocked`, `queued`, `sent`, `delivered`, `read`, `failed`.
Block reasons: `no_channel` (with each channel's reason in the
`message.blocked` event), or a specific one on a named channel.

Errors: `400` `address_missing` / `template_variable_missing`, `404`
`template_not_found`, `409` `channel_not_configured`, `422`
`unsubscribe_text_required` / `template_unfit`.

### `GET /v1/messages/:id` — tenant JWT

→ `200 { "message": … }` or `404`.

---

## Consent and suppression

### `POST /v1/consent` — tenant JWT

```json
{ "channel": "sms", "address": "+9665…", "purpose": "marketing",
  "status": "granted", "source": "signup-form", "defaultCountry": "SA" }
```

Append-only: the latest row for a contact and purpose wins, so a revoke after a
grant refuses. → `201 { "consent": … }`. Emits `consent.granted` / `consent.revoked`.

### `POST /v1/suppression` — tenant JWT

```json
{ "channel": "email", "address": "a@b.co", "reason": "complaint" }
```

→ `201 { "suppression": … }`. Emits `suppression.added`. Platform-wide blocks
exist but are not writable through the API.

### `GET /v1/can-send?channel=&address=&purpose=&at=&defaultCountry=` — tenant JWT

A dry run; sends nothing.

→ `200 { "allowed": true }` or
`{ "allowed": false, "reason": "suppressed" | "no_consent" | "rule", "rule": { id, name } }`.

The order is fixed and the first failure wins: suppression (an opt-out beats
everything, including a transactional message), then consent for `marketing`
only, then region-scoped `sending_window` rules in the contact's own local time.

---

## Rules

### `GET /v1/rules` — tenant JWT

→ `200 { "rules": [ … ] }`: platform, region and this tenant's own.

### `POST /v1/rules` — tenant JWT

```json
{ "kind": "sending_window", "name": "no-fridays",
  "document": { "==": [{ "var": "weekday" }, "fri"] } }
```

`kind` is `sending_window` or `channel_selection`. → `201 { "rule": … }`.

**Two senses, and they differ.** A `sending_window` rule *denies* when its
document is true. A `channel_selection` rule *returns a value* — an ordered
array of channels — and the most specific scope wins, so a tenant can reorder
its own channels but never lift a platform restriction, because every channel
returned still has to pass `can_send`. A promocode's own `rules` document is
different again: it says when the code *may* be used, so anything but `true`
refuses it.

### `DELETE /v1/rules/:id` — tenant JWT

Deletes only this tenant's own rule. A platform or region rule reads as `404`.
→ `204` or `404`.

---

## Companies

The prospect pool: companies **not** on the marketplace. `companies` and
`company_identifiers` are shared across tenants; what a tenant says *about* a
company is private to it.

### `POST /v1/companies` — tenant JWT

```json
{
  "name": "شركة الفلاح للتجارة",
  "country": "SA",
  "identifiers": [{ "type": "cr", "value": "1010123456" }],
  "source": { "type": "rfq", "ref": "RFQ-9" },
  "enrich": true,
  "defaultCountry": "SA",
  "tenantView": { "relationship": "prospect", "tags": ["vip"], "notes": "…" }
}
```

`source.type` is `rfq`, `import` or `api`. Identifier types are `cr`, `vat`,
`domain`, `gmaps` (strong: they merge) and `phone`, `email` (weak: they link).
A domain is stored as its registrable domain (`https://www.shop.example.com.sa/x`
→ `example.com.sa`, and `com`, `net`, `org`, `gov`, `edu`, `ac`, `co`, `sch` or
`med` under any two-letter country code is a suffix too); one on a shared host such as `salla.sa`, `instagram.com`
or `business.site`, or on a site builder or link page such as `site123.me`,
`weebly.com`, `godaddysites.com` or `bio.link`, is rejected as `shared host` and
kept only in the source's `data`. An email also yields its domain, unless that is a free-mail provider or
a shared host. `gmaps` is a Google Maps place id or cid exactly as given
(`[A-Za-z0-9:_-]`, up to 200). `enrich: true` asks the registrar about a `cr`
first, when a lookup is configured. Sources `web` and `maps` are written by
discovery itself, never by a caller.

→ `201 { "company", "created", "mergedFrom": [ … ] }`. Emits `company.created`
or `company.updated`, and `company.merged` when two records turn out to be one.

### `GET /v1/companies/:id` — tenant JWT

Follows a merge: asking for a merged-away id returns the survivor.

→ `200 { "company", "identifiers", "tenantView", "sources" }` or `404`.
`tenantView` and `sources` are yours only.

### `GET /v1/companies?identifier=cr:1010123456` — tenant JWT

Same shape, found by identifier. The value is normalised before matching.

### `PUT /v1/companies/:id/view` — tenant JWT

```json
{ "relationship": "customer", "tags": ["gold"], "notes": "…" }
```

→ `200 { "view": … }`. Yours; another tenant gets its own.

### `PUT /v1/companies/:id/profile` — tenant JWT

```json
{ "buys": ["diesel"], "sells": [], "sector": "energy", "city": "Riyadh", "size": "50-200",
  "products": ["توريد الديزل", "Diesel fuel"], "roles": ["distributor"],
  "cities": ["Riyadh", "Dammam"], "countries": ["SA"], "quality": "full",
  "profiledAt": "2026-10-01T00:00:00Z" }
```

Shared, like the company. Category codes are free strings; the engine owns no
catalogue and validates nothing against one. `products` are product names in
the company's own words, any language (`sells` keeps its meaning as category
codes). `roles` are any of `manufacturer`, `distributor`, `wholesaler`,
`retailer`, `installer`, `service_provider`, `transporter`, `other`.
`countries` are ISO 3166-1 alpha-2, upper-cased. `quality` is `full` or `thin`,
and `profiledAt`, an ISO timestamp, is when web evidence last filled the profile. A list left out
or empty, and a value left out, keeps what is stored. → `200 { "profile": … }`.
Emits `company.profiled`.

### `POST /v1/companies/import` — tenant JWT, `Content-Type: text/csv`

Up to 5,000 rows. Header exactly:

```
name,country,cr,vat,domain,phone,email,relationship,tags
```

optionally followed by `,buys,sells,sector,city`. List columns are
`;`-separated. `?ref=<name>` labels the import; each row's source reference
becomes `<ref>:<line>`.

→ `200 { "rows", "created", "linked", "merged", "rejected": [{ row, reason }] }`.
A row that offered identifiers and had none survive normalisation is rejected
with its line number: nothing could ever match it.

---

## Discovery

### `POST /v1/discovery/search` — tenant JWT

```json
{ "buys": ["diesel"], "sector": "energy", "city": "Riyadh", "country": "SA",
  "text": "الفلاح", "excludeCompanyIds": [], "limit": 20 }
```

→ `200 { "finder", "finderRunId", "candidates": [{ company, profile, view, score, reasons }] }`.

`score` is 0..1 and comparable within one finder, not between finders. Every
search is logged; **pass `finderRunId` back on an invite** so the search can be
judged by its outcome.

**The matching algorithm is a placeholder.** `basic` is an AND of exact filters
plus trigram matching on the name, so everything it returns matched everything
asked and scores 1.0. Companies already on the marketplace, and merged-away
ones, are never returned.

### Discovery for the portal — tenant JWT

Suppliers and corporates search from the marketplace portal through these
routes; `docs/PORTAL.md` is the full contract with examples. Every call carries
`requesterRef`, the portal's own id for the user who asked; a search belongs to
it, and any other `requesterRef` gets `404`. Responses never carry a company's
contacts: a result is `{ rank, company: { id, name }, city, country, persona,
fit, why }`, where `why` is the persona's checked evidence as `claim: "quote"`
or the ranking reasons, never a page address.

| Route | What |
| --- | --- |
| `POST /v1/discovery/identify` | `{ product, category? }` → `{ identified, didYouMean }` |
| `POST /v1/discovery/searches` | `{ requesterRef, productRef?, product, category?, side, countries? = ["SA"], identified?, confirmed?, resultLimit? }` → `201 { search }` |
| `POST /v1/discovery/rfq-searches` | `{ requesterRef, rfqRef?, side? = suppliers, countries?, lines: [{ lineRef?, productRef?, product, category? }] }` (1–20 lines) → `201 { rfqSearch }` |
| `GET /v1/discovery/searches?requesterRef=&productRef=&status=` | the requester's searches |
| `GET /v1/discovery/searches/:id?requesterRef=` | `{ search }` with `progress` |
| `GET /v1/discovery/searches/:id/results?requesterRef=` | `{ search, results }` |
| `GET /v1/discovery/rfq-searches?requesterRef=&rfqRef=` · `/:id?requesterRef=` | RFQ searches with each line's search |
| `GET /v1/discovery/rfq-searches/:id/results?requesterRef=` | `{ rfqSearch, lines: [{ lineRef, product, identifiedAs, status, progress, results }] }` in line order |
| `GET /v1/discovery/quota?requesterRef=` | `{ day: { used, max, resetsAt }, month: {…} }` |

A search's `progress` is one of `understanding the product`, `searching`,
`reading`, `ranking`, `done`, `failed`. Starting a search or an RFQ search over
the `discovery.quota` rule (platform row: 5 a day, 50 a month, calendar days and
months in Asia/Riyadh; an RFQ search counts as one) is
`429 { error: "quota_exceeded", limit, used, max, resetsAt }`. A catalog
product (`productRef`) searched again with the same text reuses its earlier
identification.

### `POST /v1/companies/:id/invite` — tenant JWT

```json
{ "contact": { "phone": "+9665…" }, "channel": "sms", "template": "invite",
  "variables": {}, "expiresInDays": 14, "finderRunId": 42 }
```

The template gets `invite_url`. An invite is a transactional message, so consent
and the sending rules apply to it like anything else.

→ `202 { "invite", "message" }`, or `200 { "invite": null, "message": … }` when
`can_send` refused — no invite row is written. Emits `invite.sent`.

### `GET /v1/invites/:id` — tenant JWT

→ `200 { "invite": … }` or `404`.

---

## Promocodes

### `POST /v1/promocodes` — tenant JWT

```json
{
  "code": "SAVE10",
  "currency": "SAR",
  "discount": { "type": "percent", "value": 1000, "maxDiscount": 5000, "minSubtotal": 20000,
                "productIds": ["<uuid>", "…"] },
  "budget": { "maxSpend": 500000, "maxUses": 100, "perBuyerMaxUses": 1 },
  "funders": [{ "party": "platform", "share": 0.6 }, { "party": "tenant:<uuid>", "share": 0.4 }],
  "rules": { ">=": [{ "var": "cart.subtotal" }, 100000] },
  "startsAt": "…", "endsAt": "…"
}
```

Funder shares sum to 1. A discount that does not divide evenly puts the
remainder on the first funder, so the parts always sum exactly.

`productIds` (optional, up to 500 uuids) limits the code to those products,
matched against each cart item's `sku`. With a list, the discount, its
`maxDiscount` cap and its `minSubtotal` all work on the listed lines only, each
worth `qty × unitPrice`. Absent or empty, the code covers every item and reads
`cart.subtotal`, as it always has.

→ `201 { "promocode": … }`. Emits `promo.created`.

Errors: `400` `invalid_currency` / `invalid_funders` / `invalid_discount`.

### `GET /v1/promocodes?status=` · `GET /v1/promocodes/:id` · `PATCH /v1/promocodes/:id`

List carries `usage: { uses, spend }`. `PATCH` takes `status`
(`"active" | "paused" | "ended"`), `discount.productIds`, or both. Only the
product list of a discount can change; an empty list lifts the limit.

### `POST /v1/promocodes/validate` — tenant JWT

```json
{ "code": "SAVE10", "buyerRef": "cust-1", "buyerCompanyRef": "acct-42", "companyId": null,
  "cart": { "currency": "SAR", "subtotal": 80000,
            "items": [{ "sku": "lpg", "qty": 1, "unitPrice": 80000 }] } }
```

→ `200 { "valid": true, "discountAmount": 5000, "promocodeId": …, "lines": [{ "index": 0, "sku": "lpg", "amount": 5000 }] }` or
`200 { "valid": false, "reason": … }`. Reasons, first true one wins:
`not_found`, `unknown_company`, `not_active`, `currency_mismatch`, `no_eligible_items`,
`min_subtotal`, `rule`, `budget_uses`, `budget_buyer`, `budget_spend`.
Writes nothing.

`buyerRef` and `buyerCompanyRef` are your own ids for the buyer and the buying
company. Both are opaque: the engine stores them on the redemption and in its
events and never looks them up, and a code's rules can name them. `companyId`
is optional and is a **registry** id, for a company the engine knows (one it
invited, imported or was told about through `/v1/companies`); marketplace
members are not in the registry, so send `buyerCompanyRef` for them, not
`companyId`. A `companyId` the registry never issued is `unknown_company`.

`lines` has one entry per cart item, in the order sent, with `amount: 0` for an
item the code does not cover. The discount is split across the covered items by
value; each share is rounded down and the remainder goes on the first covered
item (moving on to the next only if it would take that item below zero), so the
amounts always sum to exactly `discountAmount`. `no_eligible_items`: the code
has a product list and nothing in the cart is on it.

### `POST /v1/promocodes/describe` — tenant JWT

What each code is, for a buyer's list of saved codes. Up to 20 codes:

```json
{ "codes": ["WELCOME5", "NOPE"], "buyerRef": "cust-1" }
```

→ `200 { "codes": [ … ] }`, one entry per code in the order sent, `code` as sent:

```json
{ "code": "WELCOME5", "found": true, "status": "live",
  "kind": "percent", "percentBps": 1000, "amount": null, "currency": "SAR",
  "maxDiscount": 20000, "minSubtotal": 50000, "skus": [],
  "startsAt": "…", "endsAt": null, "usesLeftForBuyer": 1 }
{ "code": "NOPE", "found": false }
```

`status` is the same `availability` word the operator view shows, first true
one wins: `paused` or `ended` (set on the code), `scheduled` (`startsAt` not
reached), `expired` (`endsAt` passed), `exhausted` (`maxUses` reached or
`maxSpend` used up), `live`. `live` does not promise a cart validates. `percentBps` is set for a percent code
and `amount` (minor units) for a fixed one; the other is `null`. `skus` is the
product list, `[]` for every product. `usesLeftForBuyer` is this `buyerRef`'s
remaining uses under `perBuyerMaxUses` (reserved and settled count), `null`
without that limit. Optional `at` is as on validate.

Writes nothing. It does not evaluate a code's own `rules` and takes no cart, so
validate is still the answer to whether a code works on a cart and for how much.

### `POST /v1/redemptions` — tenant JWT, **`Idempotency-Key` required**

The validate body plus `orderRef` and optional `ttlMinutes`. Locks the code and
re-checks everything, so two checkouts racing for the last use cannot both pass.
`orderRef` is the natural key: the same order twice returns the same redemption
and one set of holds.

→ `201 { "redemption": …, "lines": [ … ] }` or `200 { "valid": false, "reason": … }`.
`lines` is as on validate. A retry with the same `Idempotency-Key` replays the
stored response, lines included. The same `orderRef` under a new key returns
the same redemption with the lines that were held, read back from its
`promo.reserved` event, whatever cart that call sent. Emits `promo.reserved`,
with the lines, `buyerRef` and `buyerCompanyRef` in its payload; `promo.settled`
and `promo.released` carry `buyerRef` and `buyerCompanyRef` too (null when not sent). A cart whose items add up to more than
`Number.MAX_SAFE_INTEGER` is a `400`, here and on validate.

### `POST /v1/redemptions/:id/settle` — tenant JWT, **`Idempotency-Key` required**

`{ "finalDiscountAmount": 2500 }` — optional, and never above what was reserved.
Captures what was used and releases what was not, so no hold is left open.

→ `200 { "redemption": … }`. Emits `promo.settled`. `409` from any state but
`reserved`.

### `POST /v1/redemptions/:id/release` — tenant JWT, **`Idempotency-Key` required**

`{ "reason": "cancelled" }` → `200`. Emits `promo.released`. `409` from
`settled`: a refund is a marketplace matter. Reservations nobody settles or
releases are let go automatically after `RESERVATION_TTL_MINUTES`.

### `GET /v1/redemptions/:id` · `GET /v1/redemptions?orderRef=`

→ `200 { "redemption": … }` or `404`.

### `GET /v1/promocodes/reconcile` — tenant JWT

→ `200 { "reconciliation": [{ currency, settled: { redemptions, ledger, agrees },
outstanding: { redemptions, ledger, agrees } }] }`. Both `agrees` should be
true; if either is false, the ledger and the redemptions disagree and something
is wrong.

---

## Contacts

A stored contact: any of a phone, email and Telegram id, with a name, locale,
free `attributes` and an optional link to a company. Addresses are stored
normalised and are unique per tenant, so the same number cannot land twice.
Storing a contact never records consent.

### `POST /v1/contacts` — tenant JWT

```json
{ "phone": "+9665…", "email": "a@b.co", "telegram": "123456789",
  "name": "Amal", "locale": "ar-SA", "attributes": { "tags": ["vip"] },
  "companyId": "…", "defaultCountry": "SA" }
```

Upserts: a contact that already has any of these addresses is filled in
(given fields overwrite, `attributes` merge) rather than duplicated. Without a
`companyId`, the contact is linked to whichever registry company owns its phone
or email, if one does.

→ `201 { "contact", "created": true }`, `200` when an existing one was updated.
`409 contact_ambiguous` with `contactIds` when the addresses belong to two
different contacts — the engine never merges contacts on its own. Emits
`contact.upserted`.

### `POST /v1/contacts/import?defaultCountry=SA` — tenant JWT, `Content-Type: text/csv`

The header must be exactly:

```
phone,email,telegram,name,company_cr,attributes,consent_channels,consent_purpose,consent_source,consent_date
```

- `attributes` is a JSON object, `consent_channels` is `;`-separated
  (`sms;whatsapp`), `consent_purpose` is `marketing` or `transactional`,
  `consent_source` describes the evidence ("signed supply agreement
  2026-03-11"), `consent_date` is an ISO date, not in the future.
- **A row with the consent columns filled records consent** for each channel,
  with that source, dated `consent_date`. **A row without them imports the
  contact and records nothing**: marketing to it stays blocked until consent
  arrives. Consent is never inferred from having an address. A row with only
  some of the four columns is rejected.
- `company_cr` links the contact to the registry company holding that CR, if
  there is one.

Up to 20,000 rows, in batches of 500 that each commit on their own, so one bad
row or batch cannot roll back the file.

→ `200 { "rows", "contactsCreated", "contactsUpdated", "consentRecorded",
"rejected": [{ "row": 7, "reason": "…" }] }`. Row numbers count the header as
row 1.

### `GET /v1/contacts?q=&companyId=&limit=&cursor=` · `GET /v1/contacts/:id` · `PATCH /v1/contacts/:id`

`q` matches name, phone, email or Telegram id. Lists are newest first, paged by
`cursor` (the last row's `id`). `PATCH` takes the same fields as `POST`;
an address another contact already has is `409 contact_conflict`.

---

## Audiences

A named group of contacts, of one of two kinds:

- **`static`** — an explicit member list.
- **`search`** — a definition resolved every time it is used:

  ```json
  { "finderQuery": { "buys": ["diesel"], "city": "Riyadh" },
    "contactFilter": { "hasChannel": ["sms", "whatsapp"], "tags": ["vip"], "companyIds": ["…"] } }
  ```

  The active finder runs (the same one as `/v1/discovery/search`, and logged the
  same way), and the audience is this tenant's contacts linked to the companies
  it returns. `hasChannel` keeps contacts with an address for any of those
  channels; `tags` matches `attributes.tags`. A company that joins the
  marketplace drops out, as it does from search.

### `POST /v1/audiences` — tenant JWT

`{ "name": "diesel buyers", "kind": "static" }` or
`{ "name": "…", "kind": "search", "definition": {…} }`. Names are unique per
tenant (`409 audience_exists`).

### `GET /v1/audiences` · `GET /v1/audiences/:id` · `PATCH /v1/audiences/:id` · `DELETE /v1/audiences/:id`

`members` is the member count for a static audience, `null` for a search.
`PATCH` takes `name` and, for a search audience, `definition`. `DELETE` is
`409 audience_in_use` while a campaign points at it.

### `POST /v1/audiences/:id/members` — tenant JWT

`{ "contactIds": ["…"] }` → `{ "added", "unknown": [ids this tenant does not have] }`.

Or `Content-Type: text/csv` with any of the columns `phone,email,telegram,name`
(and `?defaultCountry=`): each row is upserted as a contact first, so an address
nobody has stored becomes a contact, **with no consent**.
→ `{ "added", "contactsCreated", "rejected": [{ "row", "reason" }] }`.

Static audiences only (`400 not_static`).

### `DELETE /v1/audiences/:id/members/:contactId`

→ `204`, or `404`.

### `POST /v1/audiences/:id/preview?limit=20&purpose=marketing&channel=&evaluateAt=` — tenant JWT

**The honest answer to "who will actually get this".** Show it before
scheduling anything.

```json
{
  "total": 3, "sampled": 3, "sendable": 1,
  "contacts": [
    { "id": "…", "name": "Amal", "phone": "+1415…", "email": null, "telegram": null,
      "allowed": true, "channel": "sms", "reason": null },
    { "id": "…", "allowed": false, "channel": null, "reason": "suppressed" },
    { "id": "…", "allowed": false, "channel": null, "reason": "no_consent" }
  ]
}
```

`total` is the whole audience; `contacts` are the first `limit` of it (by
contact id), each with the verdict `send()` would give for `purpose` on its best
channel — the same consent, suppression, rules and channel selection, with
nothing written. `sendable` counts the allowed ones **among those sampled**.
`channel` pins the channel as a campaign with a channel would. `evaluateAt`
judges the sending window at another time, e.g. when the campaign will run.

---

## Campaigns

A campaign is a scheduler and a recipient list, nothing more. Every recipient
goes through `messaging.send()` exactly as `POST /v1/messages` does: consent,
rules, channel selection, templates, fallback and the event log all apply.

### `POST /v1/campaigns` — tenant JWT

```json
{
  "name": "Monday diesel offer",
  "audienceId": "…",
  "template": "diesel_offer",
  "channel": "whatsapp",
  "purpose": "marketing",
  "variables": { "offer": "5%" },
  "scheduledAt": "2026-10-01T07:00:00Z",
  "recurrence": { "cron": "0 10 * * 1", "endsAt": "2026-12-31T00:00:00Z", "maxRuns": 12 },
  "timezone": "Asia/Riyadh",
  "throttlePerMinute": 60
}
```

- `channel` null or absent: selection picks per recipient.
- `scheduledAt` absent on a one-shot: runs as soon as it is scheduled. On a
  recurrence it means "not before".
- `recurrence.cron` is a standard five-field cron (numbers, `*`, lists,
  ranges, steps) read in `timezone`. `null` is a one-shot.
- `throttlePerMinute` is 1..600, default 60 — a per-campaign send rate, because
  a supplier firing 5,000 WhatsApp messages in a minute gets their number
  flagged.
- The template gets the campaign's `variables` plus `contact` (`id`, `name`,
  `locale`, `phone`, `email`, `telegram`, `attributes`, and `address`, the one
  it went to) and `company` (`id`, `name`, `country`, or null).

Created as a `draft`. Errors: `400 template_not_found` (for the named channel,
or — with no channel — for any channel the tenant has a provider for, listed in
`missing`), `400 invalid_cron`, `400 invalid_timezone`, `400 scheduled_at_past`,
`404 audience_not_found`. Emits `campaign.created`.

### `GET /v1/campaigns?status=` · `GET /v1/campaigns/:id` · `PATCH /v1/campaigns/:id`

Each campaign carries `status`, `nextRunAt` and `lastRun` (the newest run's
counts, below).

`PATCH` takes any create field. It edits a `draft`, or a `paused` campaign
between runs — no run `expanding` or `sending`. Anything else is
`409 not_editable`: a run in progress is never changed under it. For a paused
campaign, `scheduledAt` must be in the future only if the patch sets it, and
`nextRunAt` is recomputed from the edit; `resume` queues the next run for it,
or finishes the campaign if the edit leaves no future run. Emits
`campaign.edited` when something changed.

Statuses: `draft`, `scheduled`, `running`, `paused`, `done`, `cancelled`,
`failed`.

### `POST /v1/campaigns/:id/schedule`

`draft` → `scheduled`, with the first run on the queue for `scheduledAt` (or
now), or for the next cron time.

- `400 audience_empty` — a `marketing` campaign whose audience has nobody
  sendable at the time it would run. It refuses rather than running and
  blocking everyone; preview the audience to see why.
- `409 too_many_running` — the tenant already has 5 campaigns `running`.
- `400 scheduled_at_past`, `400 recurrence_never_fires`, `409 not_draft`.

### `POST /v1/campaigns/:id/unschedule`

`scheduled` or `paused` → `draft`, while the campaign has no runs at all: for
a typo spotted before it goes out. The waiting run is taken off the queue, so a
reschedule runs at its new time. `409 already_started` once a run has begun
(pause and edit between runs, or duplicate it); `409 invalid_state` otherwise.
Emits `campaign.unscheduled`.

### `POST /v1/campaigns/:id/duplicate`

Body optional: `{ "name": "…" }`. A new `draft` copied from a campaign in any
status: audience, template, channel, purpose, variables, recurrence, timezone
and throttle. `name` defaults to `<name> (copy)`; `scheduledAt` is copied only
if it is still in the future. Every create check runs again, so a template
deleted since is `400 template_not_found`. `201 { campaign }`. Emits
`campaign.created` with `duplicatedFrom`.

### `POST /v1/campaigns/:id/pause` · `/resume` · `/cancel`

- **pause**: `scheduled` or `running` → `paused`. Nothing more is sent; pending
  recipients stay pending.
- **resume**: `paused` → `running` if a run was in progress (its batches pick
  up where they stopped), else `scheduled`.
- **cancel**: any live state → `cancelled`. The run in progress is `cancelled`
  and its pending recipients `skipped` with reason `cancelled`. Messages already
  queued are real sends and are not recalled.

A wrong state is `409 invalid_state`.

### `GET /v1/campaigns/:id/runs`

```json
{ "items": [{ "id": "…", "runNo": 2, "status": "sending",
              "startedAt": "…", "finishedAt": null,
              "audienceSize": 500, "queued": 140, "blocked": 18, "skipped": 2,
              "pending": 340, "deferred": 120, "error": null }] }
```

Newest first. Run statuses: `expanding`, `sending`, `done`, `cancelled`,
`failed`. The counts update as the run sends. `deferred` is the part of
`pending` waiting on a sending window (pending with `notBefore` in the future).
The same counts appear on each campaign's `lastRun` and on
`/internal/campaigns`.

### `GET /v1/campaigns/:id/runs/:runId/recipients?state=&limit=&cursor=`

Who got it, who didn't, and why, in one call:

```json
{ "items": [{ "contactId": "…", "name": "…", "phone": "…", "email": null, "telegram": null,
              "state": "blocked", "reason": "no_consent", "notBefore": null, "messageId": "…",
              "message": { "channel": "sms", "status": "blocked", "blockedReason": "no_channel",
                           "error": null, "updatedAt": "…" } }],
  "nextCursor": null }
```

States: `pending` (not sent yet), `queued` (a message went on the queue;
`message.status` says how it has fared since), `blocked` (`send()` refused;
terminal, never retried), `skipped` (could not be sent at all — no template for
the channel picked, no unsubscribe text, a missing variable — or cancelled).
Ordered by contact id; the cursor is the last `contactId`.

`notBefore` is set on a `pending` recipient a sending window is holding back:
it will not be tried before then.

Reasons worth knowing:

| Reason | State | Meaning |
| --- | --- | --- |
| `deferred:<rule>` | `pending` | Only the sending-window rule `<rule>` held it back. It waits until `notBefore`, the next 15-minute mark when the window is open; nothing was sent and no message row exists. |
| `no_sending_window` | `blocked` | Held back by a sending window that does not open in the next 7 days. |
| `error:<message>` | `skipped` | Sending to it threw something unexpected three times (the first 200 characters of the error). |
| `cancelled` | `skipped` | The campaign was cancelled before it was sent, deferred ones included. |
| `no_consent`, `suppressed`, … | `blocked` | `send()` refused, as for any single send. Consent and suppression are never deferred. |

### How a run works

1. At its time, `campaign.run` opens run *n* and **snapshots** the audience into
   recipients. Next Monday's run sends to next Monday's audience and never
   re-sends this Monday's. For a recurrence, run *n+1* is queued now, before
   anything is sent, so a long run cannot push the next one back.
2. `campaign.batch` takes pending recipients that are ready now and runs each
   through the same check `send()` makes. One held back only by a sending
   window (a quiet hour) is **deferred**, not blocked: it stays `pending` with
   `notBefore` set and reason `deferred:<rule>`. Everyone else is sent, blocked
   or skipped, up to `ceil(throttlePerMinute / 6)` per batch; deferring does not
   count against that. The next batch is queued ten seconds later while anyone
   is ready, or for the earliest `notBefore` when only deferred recipients are
   left. When none are pending the run is `done`, and the campaign `done`
   (one-shot, or a recurrence past `maxRuns` or `endsAt`) or back to
   `scheduled`.
3. Recipients are the retry unit: a batch that dies leaves its unsent
   recipients pending for the next. A recipient that throws something
   unexpected three times is `skipped` as `error:…`. A run that fails to expand
   is `failed`, and so is the campaign; one recipient failing never fails a run.
4. `campaign.sweep` runs every five minutes and picks up runs whose job chain
   died after pg-boss gave up on it: an `expanding` run idle for 10 minutes is
   re-expanded, a `sending` run with ready recipients idle for 5 minutes gets a
   new batch, and a `sending` run with nothing pending is finished. Each one
   emits `campaign.run.recovered`. A run waiting on deferred recipients is left
   alone.

Messages a campaign sent carry `campaignRunId` (on `GET /v1/messages/:id` too).

---

## Events

### `POST /v1/events` — tenant JWT

`{ "type", "subjectType", "subjectId", "payload" }` → `201 { "event": … }`.

### `GET /v1/events?type=&since=&limit=` — tenant JWT

→ `200 { "events": [ … ] }`, newest first. Append-only: nothing edits or
deletes an event.

---

## Webhooks out

### `POST /v1/webhooks` — tenant JWT

```json
{ "url": "https://marketplace.example.com/hooks/engine", "eventTypes": ["promo.settled"] }
```

Omit `eventTypes` for every event. The URL must be `https` unless the engine
itself is running on `http`.

→ `201 { "webhook": { id, url, eventTypes, active, createdAt }, "secret": "…" }`.
**The secret is shown once.** It is not retrievable; losing it means creating a
new endpoint.

### `GET /v1/webhooks` · `DELETE /v1/webhooks/:id`

→ `200 { "webhooks": [ … ] }` (no secrets) · `204` or `404`.

### `GET /v1/webhooks/:id/deliveries?status=` — tenant JWT

→ `200 { "deliveries": [ … ] }`, newest first, up to 200. Status is `pending`,
`delivered` or `failed`.

### `POST /v1/webhooks/:id/deliveries/:deliveryId/replay` — tenant JWT

→ `202 { "delivery": … }`, reset to `pending` and queued again.

### `POST /internal/webhooks` — internal token

The platform endpoint: hears every tenant's events, belongs to none, invisible
to all of them. Same body and response.

---

## Public routes

### `GET /i/:token`

The invite link. → `302` to `{MARKETPLACE_SIGNUP_URL}?invite=<token>` while the
invite is open, `410` once it is used or expired.

### `POST /internal/invites/accept` — internal token

`{ "token": "<invite token>", "ref": "<marketplace account id>" }` →
`200 { "companyId", "tenantId" }`. Marks the invite accepted, stamps the company
as on-platform, expires the company's other open invites, emits
`invite.accepted`. `409` if already accepted or expired, `404` if unknown.

### `POST` / `GET /unsubscribe/:token`

One-click opt-out from a marketing email's `List-Unsubscribe` header. The token
is an HMAC over tenant, channel and address, so there is no table behind it.
→ `200` (or a plain confirmation page on `GET`), `404` if tampered. Writes both
a suppression and a revoked consent.

### `POST` / `GET /webhooks/:provider/:token`

Provider callbacks; see below. → `202` almost always; `401` only for a bad
WhatsApp signature; `404` for a wrong token or unknown provider.

### `GET /health`

→ `200 { ok, db, boss, version }`, or `503` when the database is unreachable.

---

## What the marketplace has to implement

### 1. The invite handshake

1. Call `POST /v1/companies/:id/invite`. The engine sends a message containing
   `{PUBLIC_BASE_URL}/i/<token>`.
2. The invited company follows that link; the engine redirects to
   `{MARKETPLACE_SIGNUP_URL}?invite=<token>`.
3. **Your signup form carries `invite` through** to the account it creates.
4. Once the account exists, call `POST /internal/invites/accept` with
   `{ token, ref }` and your internal token.

From then on the company is out of the prospect pool's results.

### 2. The checkout handshake

1. **Validate at the cart** — `POST /v1/promocodes/validate` while the buyer is
   still typing. A refusal is a 200 with a reason.
2. **Reserve at order placed** — `POST /v1/redemptions` with an `orderRef` and
   an `Idempotency-Key`.
3. **Settle at order completed** — `POST /v1/redemptions/:id/settle`, with
   `finalDiscountAmount` if the order shrank.
4. **Release on cancel** — `POST /v1/redemptions/:id/release`.

Reconcile whenever you like; both `agrees` should always be true.

### 3. Receiving webhooks

Deliveries follow [Standard Webhooks](https://www.standardwebhooks.com), so any
library for it verifies them. Body:

```json
{ "id": "<event id>", "type": "promo.settled", "tenantId": "<uuid>",
  "occurredAt": "2026-09-21T10:00:00Z", "data": { } }
```

Headers: `webhook-id` (the delivery id), `webhook-timestamp` (unix seconds),
`webhook-signature` (`v1,<base64 hmac>`).

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, headers: Record<string, string>, body: string): boolean {
  const timestamp = Number(headers['webhook-timestamp']);
  // Reject anything older than five minutes, or a replayed body is accepted
  // forever.
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const expected = `v1,${createHmac('sha256', secret)
    .update(`${headers['webhook-id']}.${timestamp}.${body}`)
    .digest('base64')}`;

  const a = Buffer.from(headers['webhook-signature'] ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Answer `2xx`. Anything else is retried at 1m, 5m, 30m, 2h and 12h, then marked
failed and left for a manual replay. **Verify the timestamp**: the signature
alone does not stop an old body being replayed at you.

### 4. Registering the provider webhooks

Both use `{PUBLIC_BASE_URL}/webhooks/<provider>/<WEBHOOK_TOKEN>`.

- **WhatsApp (Meta)** — set it as the callback URL with `WEBHOOK_TOKEN` as the
  verify token. Meta GETs it once and expects the challenge echoed, which the
  engine does. Meta signs every payload; a bad signature is the one case a
  provider gets a 401.
- **Telegram** — register with the secret header:

  ```bash
  curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
    -d "url={PUBLIC_BASE_URL}/webhooks/telegram/<WEBHOOK_TOKEN>" \
    -d "secret_token=<WEBHOOK_TOKEN>"
  ```

- **Taqnyat** — set the delivery-report URL in their dashboard. Their callback
  shape is not in their OpenAPI spec, so the parser is deliberately permissive.
- **SMTP** — no callbacks. A sent email stays `sent`.

---

## Operator routes — internal token

The platform read side, across every tenant. `docs/DASHBOARD.md` is the guide
for building against these; this is the reference.

All of them take `X-Internal-Token`. A tenant JWT is a 401. Lists take `limit`
(1..500, default 100) and `cursor` (the last row's `id`) and return
`{ items, nextCursor }`, newest first. Windows are `since`/`until`, or
`window=1h|24h|7d|30d`.

### `GET /internal/overview?window=24h`

Everything a dashboard's front page needs, in one call:

```json
{
  "asOf": "…", "window": { "since": "…", "until": "…" },
  "health": { "db": true, "boss": "running (3 queued)", "version": "0.1.0" },
  "queue": [{ "name": "message.send", "created": 3, "active": 1, "retry": 2,
              "failed": 0, "cancelled": 0, "completedInWindow": 412 }],
  "messages": { "queued": 3, "sent": 200, "delivered": 180, "read": 40, "failed": 4, "blocked": 12 },
  "blockedReasons": { "no_consent": 9, "suppressed": 1, "rule:sa-marketing-sms-hours": 2 },
  "tenants": [{ "tenantId": "…", "tenantName": "…", "messages": {…},
                "invites": { "sent": 5, "accepted": 1 },
                "redemptions": { "reserved": 2, "settled": 9, "released": 1 },
                "webhookFailures": 0 }],
  "webhooks": { "pending": 1, "failed": 2 },
  "reservations": { "open": 2, "expiringWithin15m": 1 },
  "discovery": { "searches": 33, "invitesFromSearch": 4 },
  "campaigns": { "scheduled": 2, "running": 1, "recipientsPending": 340,
                 "sentInWindow": 1200, "blockedInWindow": 45 },
  "serper": { "usdPerCredit": 0.001,
              "window": { "searches": 2, "queries": 48, "serperCalls": 31, "cacheHits": 17,
                          "credits": 33, "usd": 0.033, "cacheRate": 0.354,
                          "perSearch": { "credits": 16.5, "usd": 0.0165 },
                          "perQuery": { "credits": 0.69, "usd": 0.000688 },
                          "perCall": { "credits": 1.06, "usd": 0.001065 } },
              "allTime": { "…": "the same shape" },
              "byKind": [{ "kind": "web", "queries": 28, "serperCalls": 19, "cacheHits": 9,
                           "credits": 21, "usd": 0.021 }],
              "byCountry": [{ "country": "SA", "…": "the same counts" }],
              "byTenant": [{ "tenantId": "…", "tenantName": "…", "…": "the same counts" }],
              "topSearches": [{ "jobId": "…", "product": "Microsilica (silica fume)", "side": "buyers",
                                "countries": ["SA"], "tenantId": "…", "tenantName": "…",
                                "…": "the same counts" }],
              "series": { "bucket": "hour", "points": [{ "at": "…", "queries": 3, "serperCalls": 2,
                                                           "cacheHits": 1, "credits": 2, "usd": 0.002 }] } }
}
```

`blockedReasons` counts the reason *per channel* from the `message.blocked`
event payload, not the `blocked_reason` column — that column says `no_channel`
for almost every block and would tell you nothing.

`campaigns.sentInWindow` and `blockedInWindow` count campaign messages created
in the window; `recipientsPending` is across every run still in progress.

`serper` is what the web searches cost, summed from the
`discovery.task.queried` events: one per query, with the credits Serper
charged (0 when the cache answered, 1 when Serper said nothing). `searches`
counts jobs that made at least one query; `perSearch`, `perQuery` and
`perCall` are averages over searches, queries and Serper calls, `null` when
there is nothing to average; `cacheRate` is `cacheHits / queries`. Money is
credits × `SERPER_USD_PER_CREDIT` (default `0.001`, the smallest pack) worked
out when read, so a corrected price corrects every figure, past and future.
`window` and `allTime` share a shape; the breakdowns are for the window:
`byKind` (`web`, `places`), `byCountry` (up to 20, costliest first), `byTenant`,
`topSearches` (the five costliest jobs, named) and `series` (hourly for a
window of up to two days, daily beyond, every bucket present).

`queue` comes from pg-boss's own tables; `completedInWindow` reads its archive
too, because finished jobs move there.

### `GET /internal/tenants` · `GET /internal/tenants/:id`

The list carries each tenant's 24-hour counts. The detail adds channels
(redacted), template names, rule counts by kind, webhook endpoints (never the
secret) and counts over 24h, 7d and 30d.

### Feeds

| Route | Filters |
| --- | --- |
| `GET /internal/events` | `tenantId`, `type` (trailing `*` is a prefix), `subjectType`, `subjectId` |
| `GET /internal/events/:id` | one event with its full payload |
| `GET /internal/messages` | `tenantId`, `status`, `channel`, `provider`, `companyId`, `address` |
| `GET /internal/messages/:id` | the message, its events, delivery reports with raw provider bodies, fallback children and parent |
| `GET /internal/redemptions` | `tenantId`, `status`, `promocodeId`; each row carries `promocodeId` |
| `GET /internal/promocodes` | `tenantId`, `status`, `code` (case-insensitive prefix); each row is the code with `tenantName`, `usage` and `availability`, below |
| `GET /internal/promocodes/:id` | `{ promocode }`, the same row |
| `GET /internal/invites` | `tenantId`, `status` |
| `GET /internal/companies` | `q` (trigram on the normalised name), `country`, `onPlatform` |
| `GET /internal/webhook-deliveries` | `status`, `tenantId`, `endpointId` |
| `GET /internal/campaigns` | `tenantId`, `status`; each row has `tenantName`, `audienceName`, `nextRunAt` and `lastRun` with its counts |
| `GET /internal/campaigns/:id` | `{ campaign, runs }`, every run with its counts |
| `GET /internal/campaigns/:id/runs/:runId/recipients` | `state`; each recipient with its message's channel and status. Ordered by contact id |

A promocode row's `usage`, all amounts in minor units:

```json
{ "uses": 2, "spend": 10000,
  "reserved": { "count": 1, "amount": 5000 },
  "settled": { "count": 1, "amount": 5000 },
  "released": { "count": 1, "amount": 5000 },
  "buyers": 2, "remainingUses": 1, "remainingSpend": 10000,
  "lastRedeemedAt": "…" }
```

`uses` and `spend` count reserved and settled redemptions, as the budget check
does. `remainingUses` and `remainingSpend` are `null` when that budget is
unset. `availability` is the first of `paused`, `ended`, `scheduled`,
`expired`, `exhausted`, `live` that holds.

Each message row carries a `timeline` of its own events in order, so a list
answers "what happened to this?" without opening it.

### Queue

- `GET /internal/jobs?name&state` → pg-boss rows: `id`, `name`, `state`,
  `retryCount`, `retryLimit`, `data`, `output`, `createdOn`, `startedOn`,
  `completedOn`, plus `tenantId`/`tenantName` when the job's data names a
  message or delivery.
- `GET /internal/jobs/:id` → one job.
- `POST /internal/jobs/:id/retry` → `200 { "retried": id }` for a `failed` job,
  `409` for any other state, `404` if unknown.
- `GET /internal/schedules` → the crons with `cron`, `timezone`, `data`, and
  when each last completed with what outcome.

### Actions

- `POST /internal/webhook-deliveries/:id/replay` → `202`, any tenant including
  the platform endpoint.

### Discovery jobs (operator)

An operator's search for supplier companies: a product and the countries to
look in, run for one tenant. A job is one task per country on the
`discovery.task` queue, and a task runs through named stages; in this step the
only stage is `rank`, which ranks the existing pool with the `products` finder.
Nothing calls the network yet. Results are the tenant's own.

#### `POST /internal/discovery/jobs`

```json
{ "tenantId": "…", "product": "ديزل", "category": "fuel", "countries": ["SA", "AE"],
  "resultLimit": 50, "side": "suppliers", "row": "…the pasted row, optional…" }
```

`identified` (optional) is the identification accepted from
`POST /internal/discovery/identify`: planning starts from it and does not ask
Claude again. `confirmed: true` (optional) says the operator confirmed
`product` (a "did you mean" they picked, or "as typed"): Claude identifies it as
written. A search never waits for the operator.

`side` is `suppliers` (default: companies that sell the product) or `buyers`
(companies that would buy and use it). With the Claude bridge configured
(`CLAUDE_RUNNER_URL`, `CLAUDE_RUNNER_TOKEN`) the job starts `planning` with no
tasks yet: on the `discovery.plan` queue it identifies the product and lists
3–6 personas for its side, then turns `running` and creates and queues one task
per country. Without the bridge a suppliers job starts `running` with its tasks
at once, and a buyers job is `400 buyers_need_planning`. Until steps 19–20 a
buyers task ranked nothing; from step 20 it ranks what was found, then pool
companies matching the personas' Maps keywords (kinds of company), never the
product's own names.

`product` is 2–200 characters after trimming; `category` is an optional label
of up to 200; `countries` are 1–10 ISO 3166-1 alpha-2 codes of real countries
(`XX` is refused), upper-cased, each once; `resultLimit` is 1–200 per country, default 50. `400` for a bad body,
`404` for an unknown tenant. → `201 { job, tasks }` in the shape of
`GET /internal/discovery/jobs/:id`, the job `running` and every task `queued`.
Emits `discovery.job.created`.

#### `POST /internal/discovery/read-row`

```json
{ "row": "ID\tProduct Name\tCategory\tPrice\n1042\tDiesel fuel 20L\tFuel\t45.00 SAR" }
```

What a row pasted from a product table says the product is, so the operator
can check it before creating a job. Cells are split on tabs (a copied web
table), else pipes, else commas when there are three or more. With the header
line pasted above the row, the product and category columns are found by name
(`product`, `name`, `item`, `اسم المنتج`, `الصنف`…; `category`, `type`,
`الفئة`, `التصنيف`…). Without one, the product is the longest cell that reads
as a name (not an id, code, price, quantity, date, URL, email or status) and
the category the next such cell. A first line with no known column name still
counts as a header when it has no digits and the row under it does; a header
pasted alone, and a markdown table's rule line, are skipped. → `200 { product,
category, cells, header, productIndex, categoryIndex, method }`, where `method`
is `header` when the columns were picked by name and `guess` otherwise; or
`400 { "error": "no_product" }` when no cell reads as a name. Nothing is
stored.

#### RFQ searches (operator)

`POST /internal/discovery/rfq-searches` `{ tenantId, rfqRef?, side?, countries,
lines: [{ lineRef?, product, category? }] }` starts an RFQ search for a tenant
(not counted against any quota) → `201 { rfqSearch, lines }`.
`GET /internal/discovery/rfq-searches?tenantId=&status=` lists them with
`rfqRef`, `requesterRef`, `products` and `lineCount`;
`GET /internal/discovery/rfq-searches/:id` gives the RFQ search and each line
(`position`, `lineRef`, `jobId`, `product`, `identifiedName`, `status`,
`counts`, `error`) in order; a line's results are its job's results. A job that
is one line of an RFQ search carries `rfqSearchId`, `rfqRef` and `lineRef`, and
every job carries `requesterRef` and `productRef` when the portal set them.

#### `POST /internal/discovery/identify`

```json
{ "product": "Fundo Cement", "category": "Building materials", "row": "…optional…" }
```

What the product is, asked before a search is created; nothing is stored.
→ `200 { identified, didYouMean }`. `identified` is Claude's identification
(`name`, `nameAr`, `brand`, `model`, `category`, `aliases`, `description`,
`uses`, `confidence` — `certain`, `likely` or `unsure` — and `alternatives`), or
`null` without the Claude bridge. `didYouMean` is decided by the engine:
`{ question, asked, best, alternatives }` when Claude is unsure and has other
readings, else `null`. A client shows it before searching; when it is `null` it
creates the search at once with `identified`. `400` for a product outside 2–200
characters.

#### `GET /internal/discovery/jobs?tenantId=&status=`

Newest first. `status` is `planning`, `running`, `done` or `failed`. Each row:
`id`, `tenantId`, `tenantName`, `product`, `category`, `side`,
`identifiedName`, `countries`, `status`, `counts`, `spend`, `createdAt`,
`finishedAt`. `spend` is what the job's searching cost, from its
`discovery.task.queried` events: `queries`, `serperCalls`, `cacheHits`,
`credits` and `usd` (credits × `SERPER_USD_PER_CREDIT`).

#### `GET /internal/discovery/jobs/:id`

```json
{ "job": { "id": "…", "tenantId": "…", "tenantName": "…", "product": "ديزل",
           "category": null, "side": "suppliers", "countries": ["SA", "AE"],
           "terms": [], "resultLimit": 50, "status": "done",
           "counts": { "ranked": 2 },
           "spend": { "queries": 30, "serperCalls": 20, "cacheHits": 10, "credits": 22, "usd": 0.022 },
           "createdAt": "…", "finishedAt": "…" },
  "tasks": [{ "id": "…", "country": "SA", "status": "done", "stage": "rank",
              "counts": { "ranked": 2 },
              "spend": { "queries": 30, "serperCalls": 20, "cacheHits": 10, "credits": 22, "usd": 0.022 },
              "error": null, "attempts": 1,
              "createdAt": "…", "startedAt": "…", "finishedAt": "…" }] }
```

The job also carries `identified` (Claude's identification: `name`, `nameAr`,
`brand`, `model`, `category`, `aliases`, `description`, `uses`, or `null`),
`error`, `sourceRow`, `attempts`, `deferrals`, `startedAt`, `waiting`, `live`,
and `productConfirmed` (the operator confirmed the product before searching).
`identified` also carries `confidence` and `alternatives`; the response has `personas` (in order: `id`, `position`, `name`,
`description`, `roles`, `sectors`, `searchTerms`, `placesTerms`, `signals`);
each task carries `deferrals` and `waiting`. `waiting` is
`{ "reason": "usage_limit", "until": "…" }` while a Claude usage limit holds the
job or task back, else `null`. `live` is `true` while the job is `planning` or
`running`. For a suppliers job `terms` are the identified aliases; a buyers job
never searches for the product's own names.

Tasks come in the job's country order. A task is `queued`, `running`, `done`
or `failed`; `stage` is the stage running now or the last one run, and
`error` is set when the task failed. A task is retried by the queue and failed
on its last attempt. The job is `done` once no task is open and at least one is
done, `failed` if every task failed; its `counts` are its tasks' counts
summed.

#### `GET /internal/discovery/jobs/:id/results?country=`

Ranked best first (`rank` is 1.. within each country), paged with `limit` and
`cursor` like every list. Each row:

```json
{ "id": "17", "rank": 1, "score": 0.7, "country": "SA",
  "reasons": ["product: ديزل ~ توريد الديزل", "profile: full", "profiled 5 days ago"],
  "company": { "id": "…", "name": "…", "country": "SA" },
  "profile": { "products": ["توريد الديزل"], "roles": ["distributor"],
               "cities": ["Riyadh"], "quality": "full", "profiledAt": "…" },
  "identifiers": [{ "type": "domain", "value": "example.com.sa" },
                  { "type": "gmaps", "value": "ChIJ…" },
                  { "type": "phone", "value": "+966…" }] }
```

`profile` is `null` for a company without one. `identifiers` are its
`domain`, `email`, `gmaps` and `phone` values. Each row also has `tier`
(`found`: this search found, read and saved it; `pool`: already in the pool and
matched), `persona` (`id`, `name`, or `null`), `fit` (`strong`, `weak` or
`null`) and `evidence`: quotes checked against the page they came from, each
`{ claim, quote, url }`. Found rows always rank above pool rows.

**How a task reads and ranks** (step 20). The `read_extract` stage takes the
kept candidates in triage order, up to `DISCOVERY_MAX_READS` per task (default
25), one at a time:
- a company profiled from the web in the last 90 days is not read again; it is
  ranked from its stored profile and its triage fit;
- otherwise its home page and up to three product, about or contact pages on
  its own registrable domain are read into memory, through the self-hosted
  Firecrawl (`FIRECRAWL_URL`, its markdown turned into plain text) or a guarded plain fetch (every address checked
  public, redirects followed by hand on the same domain only, 2 MB and 15 s
  caps); a Maps-only company is judged from its listing;
- Claude extracts the name, products, roles, cities, the persona it fits and
  evidence, every fact with a quote; a quote that is not on the page its `url`
  names (at least 12 characters, compared folded) is dropped;
- phones, emails and WhatsApp numbers are taken from the text by pattern, never
  from Claude; a CR found on a page is kept as `crClaimed` on the source and
  becomes an identifier only when Wathq names the same company;
- the company is saved through `registry.upsert` (source `web`, or `maps` when
  no page of its site could be read; the job's tenant owns the source row;
  never linked to an existing company by name alone), and its profile is
  merged, never replaced: lists unioned, quality only ever raised, `profiledAt`
  stamped only when web pages were read;
- identity is claimed carefully: the domain only when its pages were read;
  emails only on that domain; a Maps id only for a company with no website read
  or whose listing carries the saved name (otherwise kept as `listingCid` on
  the source); a CR only when Wathq gives exactly the same name;
- a quote must be 12–300 characters once folded and appear on its page as
  whole words.

A candidate is "fresh" (not read again) when its company was profiled from the
web in the last 90 days, before this job started.

No page is stored: only checked quotes, in the source row's `data.quotes` and
the result's `evidence`. A job makes at most `DISCOVERY_MAX_CLAUDE_CALLS`
Claude calls (default 60) across planning, triage and extraction.

Found companies score `0.6` (strong fit) or `0.3` (weak), plus `0.2` × the
share of the persona's signals their evidence shows, plus the quality and
freshness weights below. Pool companies come after them: for suppliers the
`products` finder with the product's names, for buyers with the personas' Maps
keywords.

Counts from reading: `read`, `read_failed`, `read_skipped_fresh`,
`reads_capped`, `firecrawl`, `fetch_fallback`, `extracted`, `quotes_checked`,
`quotes_dropped`, `saved`, `not_saved`, `extract_failed`, `extract_capped`,
`claude_calls`. Candidates are marked `extracted`, `not_saved` or `failed` as
they are read, with a reason; the candidates route returns each one's checked
`evidence`.

#### `GET /internal/discovery/jobs/:id/results.csv?country=`

The same results as a file to download: `text/csv; charset=utf-8` with a
byte-order mark (so a spreadsheet reads Arabic correctly), `Content-Disposition:
attachment` named after the product, side, country and date, at most 2 000
rows. Columns: `rank, country, tier, score, company, company_id, persona, fit,
domains, phones, emails, google_maps_ids, products, roles, cities,
profile_quality, profiled_at, evidence, reasons`; lists are joined with `; `,
evidence as `claim: "quote" (url)` joined with ` | `. A text cell from a web page
that a spreadsheet would read as a formula (starting `=`, `+`, `-`, `@`) is
prefixed with `'`. `404` for an unknown job.

#### `GET /internal/discovery/countries` · `POST /internal/discovery/countries/:code`

How each country is searched: every `discovery.country` row as `{ items: [{
code, name, rule, enabled, settings, createdAt }] }`, by code. `name` is the
country's English name; `rule` is the row's name, which says who made it
(seeded, `made by Claude` or `set by operator`).

`POST` with `{ settings: { gl, languages, suffix, names, cities }, timezone? }`
replaces the country's row, or creates it, as "Search <country> (set by
operator)". Every language is a two-letter code, listed once, at most 4; a
suffix only in those languages; every city named in at least one of them.
`timezone` is used only when the country is not yet a region. `400` for a bad
code or settings → `{ country }`. The next job in that country searches with
it.

#### `GET /internal/discovery/jobs/:id/candidates?country=&status=kept,new`

What the job's searches turned up, one row per company, kept first (strong fits
before weak), then new, then dropped; paged with `limit` and `cursor`. Each row:
`id`, `country`, `kind` (`web`, `maps` or `both`), `domain`, `gmaps`, `name`,
`url`, `phone`, `address`, `category`, `snippets` (up to five
`{ query, title, snippet }`), `personas` (`id`, `name`), `fit` (`strong`,
`weak` or `null`), `status` (`new`, `kept`, `dropped`), `reason` and
`companyId` (set when the domain or Maps id is already in the pool). `status`
takes one status or several, comma-separated. A candidate whose phone belongs
to a pool company is not matched by it (a phone is weak); its reason notes
`phone matches <company>`. Each persona term carries its language (`lang`) from
the personas step; only terms in one of the country's `languages` are
searched, each with that language as Serper's `hl`, and a Maps listing whose own website is a blocked host is dropped
like the website.

**How a task searches** (with `SERPER_API_KEY` and the Claude bridge both
set; with either unset `search` and `triage` are skipped and counted as
such). For each persona: every search term on the web, once as written and once
with the country's suffix in the term's language; every Maps keyword, alone and
with each of the country's first three cities. Personas take turns up to
`DISCOVERY_MAX_QUERIES` per task (default 30), and no task exceeds its share of
`DISCOVERY_MAX_QUERIES_PER_JOB` (default 60). Each query is answered from the
shared `search_queries` cache when it was asked in the last
`SEARCH_CACHE_DAYS` (default 30), else by Serper, throttled to `SERPER_RPS`.
Web hits are grouped by registrable domain and Maps listings by Maps id, a
listing joining the website it names; a hit on a shared host is dropped
(`shared host`), and one on a host the `discovery.blocked_hosts` rules deny is
dropped (`blocked host`). Claude then triages the rest in batches of 40 from
their names, snippets, addresses and categories: keep (with a fit and the
personas) or drop, with a reason. An exhausted or refused Serper key fails the
task at once with `search provider refused: …`.

Task counts from these stages: `queries`, `queries_capped`, `serper_calls`,
`serper_credits`, `cache_hits`, `hits`, `candidates`, `dropped_shared`,
`dropped_blocked`, `kept`, `dropped`, `triage_failed`, `claude_calls`. The
counts are for display; what a search cost is read from its events (`spend`,
the queries route and the overview), which a task that failed half-way still
has.

**Rule kinds.** `discovery.country` is a value rule, one region row per
country, read for the task's country: `{"if": [true, { gl, languages, suffix,
names, cities }, null]}`. `languages` are ISO 639-1 codes; `suffix` and each
city are keyed by language (`{ "en": "Cairo", "ar": "القاهرة" }`). Rows are
seeded for `SA` and `AE`. Any other country gets its row the first time a job
searches it: the job's `countries` plan stage asks Claude for its languages
(English always added), names and main cities, and saves the row as "Search
<country> (made by Claude)", adding the country to `regions` in the time zone
Claude names (UTC when that zone is unknown). Later jobs reuse the row; the
operator corrects it with `POST /internal/discovery/countries/:code`. Without
the bridge a country with no row searches with `gl` = its code, in English. A
country's `names` and `cities` are also the place names a persona's terms may
not carry.
`discovery.blocked_hosts` is a deny rule checked per candidate domain with
context `{ host }`, e.g. `{"in": [{"var": "host"}, ["example.com"]]}`; the
platform row lists directories, marketplaces, job boards and news sites. A
tenant's own rows add to it and can never lift it; they are written by step
21's "block a domain" action (until then, as a tenant row in `rules`).

**How `rank` scores.** A product term matches a profile product when the
folded term is inside the folded product, or their trigram similarity is at
least 0.4; only companies with a match come back, in the task's country by
`companies.country` or profile `countries`, never merged away or on the
platform. The score (0..1) is 0.5 × the best product similarity (containment
counts as 1), plus 0.15 for a matching role, 0.15 for a matching city, 0.1 for
a `full` profile or 0.05 for a `thin` one, and 0.1 for freshness: full within
90 days of `profiledAt`, falling to nothing at 365. Each signal that scored is
one reason.

#### `GET /internal/discovery/queries?jobId=&tenantId=&country=&kind=&cached=`

Every query the searches made, newest first, each priced: the log the spend
figures are summed from. With `jobId` it is the job's whole history; without
it the window applies (default `7d`). `kind` is `web` or `places`; `cached`
is `true` or `false`. Paged with `limit` and `cursor` (the last row's `id`).
Each row: `id`, `at`, `tenantId`, `tenantName`, `jobId`, `product` (the
identified name, else as entered), `side`, `taskId`, `country`, `persona`
(the persona's name, `null` when it is gone), `kind`, `q`, `gl`, `hl`,
`cached`, `credits` (0 when cached), `usd` and `hits`.

#### Events

| Event | Payload |
| --- | --- |
| `discovery.job.created` | `jobId`, `product`, `countries` |
| `discovery.task.finished` | `jobId`, `taskId`, `country`, `counts` |
| `discovery.task.failed` | `jobId`, `taskId`, `country`, `error`, `attempts` |
| `discovery.job.finished` | `jobId`, `status`, `counts`, `requesterRef`, `productRef`, `rfqSearchId`, `lineRef`, and `error` for a job that failed in planning |
| `discovery.rfq.created` | `rfqSearchId`, `rfqRef`, `requesterRef`, `lines: [{ lineRef, jobId, product }]` |
| `discovery.rfq.finished` | `rfqSearchId`, `rfqRef`, `requesterRef`, `status`, `lines: [{ lineRef, jobId, status, ranked }]` |
| `discovery.job.planned` | `jobId`, `product` (the identified name), `personas` (names) |
| `discovery.job.deferred` | `jobId`, `resetsAt` |
| `discovery.task.deferred` | `jobId`, `taskId`, `country`, `resetsAt` |
| `discovery.task.queried` | one per query, as it happens: `jobId`, `taskId`, `country`, `personaId`, `provider` (`serper`), `kind` (`web`, `places`), `q`, `gl`, `hl`, `page`, `cached`, `credits` (what Serper charged; 0 from the cache), `hits` |

All of them have `subjectType: "discovery_job"` and the job's id as `subjectId`,
so one filter reads a job's whole history. Every rank also writes a
`finder_runs` row with `finder = "products"`.

### `GET /internal/metrics`

`series=messages|events|redemptions|searches`, `bucket=hour|day`, optional
`tenantId` and `groupBy` (`status`/`channel` for messages, `status` for
redemptions, `type` for events).

→ `{ bucket, series: [{ key, points: [["2026-09-21T10:00:00Z", 12], …] }] }`

### `GET /internal/stream`

Server-Sent Events, one frame per event as it commits. Optional `tenantId` and
`type` (trailing `*` is a prefix).

```
id: 48213
event: message.sent
data: {"id":"48213","type":"message.sent","tenantId":"…","subjectType":"message", …}
```

Send `Last-Event-ID` on reconnect and the engine replays what you missed (up to
1000 rows) before going live. A heartbeat comment arrives every 15 seconds. At
most 20 concurrent streams; the 21st gets `503 too_many_streams`. The payload
is small by design — `GET /internal/events/:id` has the rest.

Events reach the stream only when their transaction commits, so nothing you see
here was later rolled back.

---

## Event types

`tenant.created` · `channel.configured` · `template.saved` · `consent.granted` ·
`consent.revoked` · `suppression.added` · `message.queued` · `message.blocked` ·
`message.sent` · `message.delivered` · `message.read` · `message.failed` ·
`message.replied` · `message.fallback` · `company.created` · `company.updated` ·
`company.merged` · `company.profiled` · `discovery.searched` ·
`discovery.job.created` · `discovery.job.planned` · `discovery.job.deferred` ·
`discovery.rfq.created` · `discovery.rfq.finished` ·
`discovery.task.finished` · `discovery.task.failed` · `discovery.task.deferred` ·
`discovery.task.queried` ·
`discovery.job.finished` · `invite.sent` ·
`invite.accepted` · `promo.created` · `promo.reserved` · `promo.settled` ·
`promo.released` · `contact.upserted` · `audience.saved` · `audience.deleted` ·
`campaign.created` · `campaign.scheduled` · `campaign.run.started` ·
`campaign.run.finished` (payload: `runId`, `runNo`, `audienceSize`, `queued`,
`blocked`, `skipped`) · `campaign.paused` · `campaign.resumed` ·
`campaign.cancelled` · `campaign.failed` · `campaign.done` ·
`campaign.unscheduled` (payload: `from`) · `campaign.edited` (payload:
`status`, `appliesFromRun`, `changes: { field: { from, to } }` with only the
fields that changed — so "runs 1–3 used A, run 4 on used B" is read from the
log) ·
`campaign.run.recovered` (payload: `runId`, `runNo`, `action` — one of
`resume_expansion`, `enqueue_batch`, `finish`)

A campaign's individual sends emit the usual `message.*` events; there is no
per-recipient campaign event.
