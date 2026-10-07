# Discovery in the marketplace portal — integration contract

What the portal team needs to add discovery to the supplier and corporate portals. The engine does the searching. The portal shows the results, and calls the engine from its **backend**, never from the browser.

## The two journeys

| | Supplier | Corporate |
|---|---|---|
| Starts from | one of its own catalog products | one of its RFQs (one or more items) |
| Finds | **buyers**: corporates that would use the product | **suppliers**: companies that sell the RFQ's items |
| Engine call | `POST /v1/discovery/searches` with `side: "buyers"` | `POST /v1/discovery/rfq-searches` (`side` defaults to `"suppliers"`) |
| Results | one ranked list | one ranked list **per RFQ item**, in the RFQ's order |

## How to call it

- **Auth.** Every call uses the marketplace's tenant token: `Authorization: Bearer <JWT>` (see `docs/API.md`, Authentication). POSTs may send an `Idempotency-Key`, which is worth doing so a retried click does not start a second search.
- **`requesterRef`** is your own id for the supplier or corporate using the portal: an opaque string, up to 200 characters. Send it on every discovery call.
  - Each search belongs to the requester that started it. Any other `requesterRef` gets `404`.
  - Your backend must take `requesterRef` from the logged-in session, never from the browser.
- **Contacts are never returned.** A result has a company's **name, city and why it matches**: no phone, email, website or identifier.
- **Results are shown at once.** There is no review gate.
- **Any country.** `countries` takes any real ISO 3166-1 code, and every country is searched the same way: in the languages companies there use, with its name and main cities. The first search in a country the engine has not searched before spends a little longer on "understanding the product" while it learns the country once.

### Supplier: "Find buyers for this product"

1. **Optional: confirm the product.** Catalog products are usually clear, so this can be skipped. The call:

   ```
   POST /v1/discovery/identify   { "product": "Calcium Hypochlorite 70% Granular - 45 kg Drum" }
   → 200 { "identified": {…} | null, "didYouMean": null | { question, asked, best, alternatives } }
   ```
   - If `didYouMean` is set, show it, and start the search with whatever the user picks.
   - If it is `null`, start the search at once, passing `identified` along.
2. **Start the search.**

   ```
   POST /v1/discovery/searches
   { "requesterRef": "sup-4411", "productRef": "cat-91822",
     "product": "Calcium Hypochlorite 70% Granular - 45 kg Drum",
     "category": "Water Treatment Chemicals", "side": "buyers",
     "countries": ["SA"],                     // optional, default ["SA"]; any country's ISO code
     "identified": {…}                        // optional, from step 1
   }
   → 201 { "search": { "id", "status": "planning", "progress": "understanding the product", … } }
   ```
   - `productRef` is your catalog product id. Searching the same product again reuses its identification.
   - If the user picked a "did you mean" option, send that name as `product` with `"confirmed": true`.
3. **Wait** for the `discovery.job.finished` webhook (below), or poll `GET /v1/discovery/searches/:id?requesterRef=`. `progress` is a word you can show as it is: `understanding the product`, `searching`, `reading`, `ranking`, `done`, `failed`.
4. **Show the results.**

   ```
   GET /v1/discovery/searches/:id/results?requesterRef=sup-4411
   → 200 { "search": {…}, "results": [
       { "rank": 1, "company": { "id": "…", "name": "Seerah" }, "city": "Riyadh", "country": "SA",
         "persona": "Swimming pool operators & pool contractors", "fit": "strong",
         "why": ["Keeps pool water safe: \"Maintaining proper chlorine and pH levels for safety.\""] } ] }
   ```

### Corporate: "Find suppliers for this RFQ"

1. **Start one search for the whole RFQ.**

   ```
   POST /v1/discovery/rfq-searches
   { "requesterRef": "corp-7", "rfqRef": "RFQ-2026-0142", "countries": ["SA"],
     "lines": [
       { "lineRef": "L1", "product": "Calcium Hypochlorite 70% Granular - 45 kg Drum" },
       { "lineRef": "L2", "product": "Diesel fuel", "productRef": "cat-120" }
     ] }
   → 201 { "rfqSearch": { "id", "rfqRef", "status": "running", "lines": [ { "lineRef": "L1", "product", "progress", … }, … ] } }
   ```

   Up to 20 lines. Each line runs as its own product search, but the RFQ is **one search** for the quota.
2. **Wait** for `discovery.rfq.finished`, or poll `GET /v1/discovery/rfq-searches/:id?requesterRef=`, which shows each line's `progress`.
3. **Show the results, split by product.**

   ```
   GET /v1/discovery/rfq-searches/:id/results?requesterRef=corp-7
   → 200 { "rfqSearch": { "id", "rfqRef", "status", … },
           "lines": [
             { "lineRef": "L1", "product": "…", "identifiedAs": "Calcium Hypochlorite 70% Granular",
               "status": "done", "progress": "done", "results": [ { "rank": 1, "company": {…}, "city", "why": [...] }, … ] },
             { "lineRef": "L2", … } ] }
   ```

   A line that failed has `status: "failed"` and no results. The other lines still count.

## Lists, history and the quota

| Route | What |
|---|---|
| `GET /v1/discovery/searches?requesterRef=&productRef=&status=&limit=&cursor=` | The requester's product searches, newest first |
| `GET /v1/discovery/rfq-searches?requesterRef=&rfqRef=&limit=&cursor=` | The requester's RFQ searches, newest first |
| `GET /v1/discovery/quota?requesterRef=` | `{ day: { used, max, resetsAt }, month: { used, max, resetsAt } }` |

- **Limits.** Each requester may start **5 searches a day and 50 a month**, counted in calendar days and months in Riyadh time.
- **Over the limit**, a start answers `429 { "error": "quota_exceeded", "limit": "day" | "month", "used", "max", "resetsAt" }`. Show it as "you can search again at …".
- **Changing the numbers.** They come from the platform's `discovery.quota` rule. The operator can give a tenant its own numbers.

## Webhooks

Register an endpoint once with `POST /v1/webhooks` and the event types below. Deliveries are signed: see "Receiving webhooks" in `docs/API.md`.

| Event | When | Payload |
|---|---|---|
| `discovery.job.finished` | a product search finished | `jobId`, `status`, `counts`, `requesterRef`, `productRef`, `rfqSearchId`, `lineRef` |
| `discovery.rfq.created` | an RFQ search started | `rfqSearchId`, `rfqRef`, `requesterRef`, `lines: [{ lineRef, jobId, product }]` |
| `discovery.rfq.finished` | an RFQ search's last line finished | `rfqSearchId`, `rfqRef`, `requesterRef`, `status`, `lines: [{ lineRef, jobId, status, ranked }]` |

- For a product search, `jobId` is the search's `id`.
- An RFQ's lines also send their own `discovery.job.finished`, with `rfqSearchId` set. A portal that only shows RFQs as a whole can ignore those.

## What the portal builds

- **Supplier product page.** A "Find buyers" button opens a progress card (`progress`), then the results list (name, city, why). Show the quota from `GET quota` next to the button.
- **Corporate RFQ page.** A "Find suppliers" button opens the same progress, per item, then the results grouped by item.
- **Backend.** A thin proxy that adds the tenant token and the logged-in user's `requesterRef`, plus a webhook receiver that marks searches ready.

## Not yet

Contacting a found company from the portal (invite to the platform, or to quote on an RFQ) is a later step. Results are read-only for now.
