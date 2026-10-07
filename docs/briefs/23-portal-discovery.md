# Brief 23 — Discovery for the portal: suppliers and corporates

Asked for on 2026-10-07. Discovery moves from the operator dashboard to the marketplace portal:

- **A supplier** picks one of its own catalog products and searches for **buyers**: corporates that would use it.
- **A corporate** picks one of its RFQs, which may have several products, and searches for **suppliers**. It is **one search**, with results **split by product**:

```
RFQ A
├─ Product A → Company A, B, C
└─ Product B → Company A, B, C
```

Decided:
- Portal users see only a company's **name, city and why it matches**: no phone, email, website or identifiers.
- Results reach the portal **immediately**, with no review gate.
- Each requester may run **5 searches a day and 50 a month**. An RFQ search counts as one.

## Who and what a search is for

`discovery_jobs` gains, in migration `0023_discovery_portal.sql`:
- `requester_ref`: the portal's own opaque id for the supplier or corporate that asked;
- `product_ref`: the portal's catalog product id;
- `rfq_search_id` and `line_ref`, `line_position`: for a search that is one line of an RFQ search.

The engine stores and filters on these values. It never looks them up, as with `buyerCompanyRef`.

**Reuse.** A search for a `product_ref` the tenant has searched before, with the same product text, reuses that search's identification. It makes no new identify call.

## RFQ searches

A new table, `discovery_rfq_searches` (tenant RLS, in 0023):
- columns: `id`, `tenant_id`, `rfq_ref`, `requester_ref`, `side` (default `suppliers`), `countries`, `status` (`running`, `done`, `failed`), `counts`, `created_at`, `finished_at`;
- one product search (a `discovery_jobs` row) per RFQ line, at most 20 lines, each planned, searched, read and ranked exactly as today;
- when its last line finishes, the RFQ search is `done` if any line is done (else `failed`), its counts are the lines' counts summed, and `discovery.rfq.finished` is emitted with every line's search id, status and ranked count;
- results are returned grouped by line, in line order.

## Limits

- A new rule kind, `discovery.quota`, is a value rule. The platform row (`{ day: 5, month: 50, timezone: "Asia/Riyadh" }`) counts calendar days and months in that zone, and a tenant row may set its own numbers.
- A `/v1` search or RFQ search over either limit answers `429 { error: "quota_exceeded", limit: "day" | "month", used, max, resetsAt }`.
- Operator searches (`/internal`) are not limited.
- `GET /v1/discovery/quota?requesterRef=` returns `{ day: { used, max, resetsAt }, month: { … } }`, so the portal can show what is left.

## The portal API (`/v1`, tenant JWT, `Idempotency-Key` accepted)

| Route | What |
| --- | --- |
| `POST /v1/discovery/identify` | The "did you mean" step, as in 20b |
| `POST /v1/discovery/searches` | One product. `{ requesterRef, productRef?, product, category?, side, countries?, identified?, confirmed? }`; `countries` defaults to `["SA"]` |
| `POST /v1/discovery/rfq-searches` | `{ requesterRef, rfqRef, side?, countries?, lines: [{ lineRef, product, category? }] }` |
| `GET /v1/discovery/searches?requesterRef=&productRef=&status=` | The requester's own searches, newest first |
| `GET /v1/discovery/searches/:id` | Status, product (as asked and as identified) and progress |
| `GET /v1/discovery/searches/:id/results` | Ranked results, portal view |
| `GET /v1/discovery/rfq-searches?requesterRef=&rfqRef=` and `/:id` | RFQ searches and their lines' status |
| `GET /v1/discovery/rfq-searches/:id/results` | Results grouped by line: `[{ lineRef, product, status, results: [...] }]` |
| `GET /v1/discovery/quota?requesterRef=` | What is left today and this month |

- **`requesterRef` is required on every `/v1` discovery call.** A search or RFQ search belongs to the requester that created it: asking for another requester's is `404`, the same answer as a search that does not exist.
- **A result in the portal view** is `{ rank, company: { id, name }, city, country, persona, fit, why: [...] }`:
  - `city` is the profile's first city;
  - `why` is the persona and each piece of checked evidence as `claim: "quote"`, never the page URL. A result from the pool gives its ranking reasons, again without URLs.
  - No identifier, phone, email, domain or Maps id is ever in a `/v1` discovery response.
- **Webhooks.** `discovery.job.finished` and `discovery.rfq.finished` carry `requesterRef`, `productRef`, `rfqRef` and `rfqSearchId`, so the portal knows when results are ready without polling.

## Operator side and dashboard

- `GET /internal/discovery/rfq-searches` and `/:id` list RFQ searches. The detail gives each line with its search, its status and its full operator results.
- **New search form** gains "RFQ search": an RFQ reference and several products, one per line.
- **The Discovery view** gains an **RFQ searches** list. An RFQ search's page shows the RFQ, then each product with its status and ranked companies.
- **A product search** that belongs to an RFQ links back to it.

## Not in this step

Inviting found companies from the portal: outreach would use the engine's contacts, which the portal user never sees, and needs its own consent and channel decisions. Results are read-only for now.

## Tests

1. **Portal view.** A `/v1` search by one requester:
   - runs as an operator search does;
   - its results carry only `name`, `city`, `country`, `persona`, `fit` and `why`: no URLs, phones, emails or domains anywhere in the response;
   - another requester gets `404`.
2. **RFQ search.** Two lines run as two searches. Results come back grouped by line, in order, `discovery.rfq.finished` fires once, and a line that fails leaves the RFQ `done` when the other line is done.
3. **Quota.** The 6th search in a day is `429` with `resetsAt`; an RFQ search counts as one; `GET quota` reports what is used; a tenant row raises the limit; operator searches are not counted against it.
4. **Reuse.** A second search for the same `productRef` makes no identify call.
5. **Webhook payloads** carry the portal's references.

## Docs

- `docs/PORTAL.md`: the contract for the portal team (both journeys step by step, routes, fields, the webhooks and example payloads).
- `docs/API.md` and `docs/DASHBOARD.md` are updated.
