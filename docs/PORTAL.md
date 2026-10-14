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

## Supplier: found buyers as an audience

A supplier who has run **Find buyers** can turn one or several of its finished searches into an **audience** and send it a campaign. The engine contacts the buyers as **outreach**: no marketing consent is needed, every opt-out and sending window still applies, and the supplier never sees a buyer's phone or email. A company found in several searches is one buyer and gets one message.

As for discovery, the portal backend sets `requesterRef` from the session and forwards only the calls below. An audience can only draw on that requester's own searches.

1. **Preview while picking.** Show the counts and the buyer list as the supplier ticks searches, and let it untick buyers.

   ```
   POST /v1/audiences/discovery-preview
   { "requesterRef": "sup-4411", "searchIds": ["…", "…"], "fit": ["strong"], "excludeCompanyIds": [] }
   → 200 { "companies": 86, "reachable": 64, "unreachable": 22,
           "buyers": [ { "company": { "id": "…", "name": "Seerah" }, "city": "Riyadh", "country": "SA",
                         "fit": "strong", "rank": 1, "searchIds": ["…"], "reachable": true }, … ] }
   ```

   - `searchIds`: 1 to 20 of the requester's searches, each `done`. A search that is missing or another requester's is `400 { "error": "search_not_found", "ids": [...] }`; one still running is `400 { "error": "search_not_done", "ids": [...] }`.
   - `fit`: `["strong"]` (the default) or `["strong", "weak"]` to include the possible buyers too.
   - `buyers` is the whole de-duplicated list, best rank first. `reachable` says whether the engine holds a phone or an email for the company, never which. An unreachable buyer gets no message. Companies that have since joined the marketplace are left out.
   - Nothing is saved. Call it again with a saved audience's `definition` to list that audience's buyers.
2. **Create the audience.**

   ```
   POST /v1/audiences
   { "name": "Buyers: Calcium Hypochlorite + 2 more", "kind": "discovery",
     "definition": { "requesterRef": "sup-4411", "searchIds": ["…", "…"], "fit": ["strong"], "excludeCompanyIds": ["…"] } }
   → 201 { "audience": { "id", "name", "kind": "discovery", "definition", "members": null, … } }
   ```

   `PATCH /v1/audiences/:id` changes `name` or `definition` with the same checks; `DELETE` works as today (`409 audience_in_use` while a campaign points at it).
3. **Preview who will get it.** `POST /v1/audiences/:id/preview` answers as for any audience, with `companies`, `reachable` and `unreachable` added, and every contact's `phone`, `email` and `telegram` as `null` beside `company: { id, name }`. `purpose` defaults to `outreach` here. This resolves the audience, so it is the same list the campaign will send to.
4. **Send the campaign.** Create it with `purpose: "outreach"` (or leave `purpose` out: a discovery audience defaults to it) and `channel: null` so the engine picks the best channel per buyer, then schedule, pause, resume and cancel exactly as today.

   ```
   POST /v1/campaigns
   { "name": "Calcium hypochlorite intro", "audienceId": "…", "template": "buyer_intro",
     "channel": null, "purpose": "outreach", "variables": { "product": "Calcium Hypochlorite 70%" } }
   → 201 { "campaign": { "id", "status": "draft", "purpose": "outreach", … } }
   POST /v1/campaigns/:id/schedule
   ```

   - The template must exist for every channel the tenant has a provider for (`400 template_not_found` lists the `missing` ones). It gets `contact.name` (the company's name) and `company`; a buyer's `contact.phone`, `email` and `telegram` are `null` in the template too.
   - `outreach` goes only to a discovery audience, and a discovery audience takes only `outreach`: anything else is `400 purpose_mismatch`. A single `POST /v1/messages` with `outreach` is `400 purpose_not_allowed`.
   - The recipients list (`GET /v1/campaigns/:id/runs/:runId/recipients`) and `GET /v1/messages/:id` show each buyer as `company: { id, name }` with no address. A buyer blocked as `suppressed` opted out earlier (an unsubscribe, a STOP, a complaint) and will stay blocked; one `pending` with `notBefore` is waiting for its country's sending window.
   - A recurring outreach campaign resolves the audience again on each run, so a buyer that opted out or joined the marketplace drops out of the next run.

Not in this step: showing contacts to the supplier, a reply path or an invite link, per-buyer frequency caps across campaigns, and audiences from corporate RFQ searches.

## What the portal builds

- **Supplier product page.** A "Find buyers" button opens a progress card (`progress`), then the results list (name, city, why). Show the quota from `GET quota` next to the button. From a finished search, "Contact these buyers" picks searches with the preview above, saves the audience and starts an outreach campaign.
- **Corporate RFQ page.** A "Find suppliers" button opens the same progress, per item, then the results grouped by item.
- **Backend.** A thin proxy that adds the tenant token and the logged-in user's `requesterRef`, plus a webhook receiver that marks searches ready.

## Not yet

Contacting a found **supplier** from an RFQ search (an invite to the platform, or to quote) is a later step; RFQ results are read-only for now.
