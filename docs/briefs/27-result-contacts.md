# Brief 27 — Contacts on search results

Asked for on 2026-10-21 by the supplier portal: "We want suppliers to see the phone numbers and emails of the companies their search found, on the search results page in the portal." For each result of `GET /v1/discovery/searches/{id}/results` they want every phone number and every email the engine holds for the company and its website, with an empty value when there is none, and everything else in the response unchanged.

This reverses one decision of brief 23 ("Portal users see only a company's name, city and why it matches: no phone, email, website or identifiers") for the results routes only. Brief 26's hidden contacts stay as they are.

Decided (product owner, 2026-10-21):
- **Portal results carry a company's contacts.** Every phone, every email and one website, from the registry.
- **Both sides.** A buyers search and a suppliers search, and so the lines of an RFQ search too.
- **Opt-outs do not hide an address.** A phone or email on a platform or tenant suppression list is still shown. Suppression keeps governing what the engine sends, through `can_send()`; it does not govern what a portal user may read.

## The result

A result in the portal view gains three fields. Nothing else in it changes, and nothing else in either response changes.

```json
{ "rank": 1, "company": { "id": "…", "name": "Seerah" }, "city": "Riyadh", "country": "SA",
  "persona": "…", "fit": "strong", "why": ["…"],
  "phones": ["+966501234567", "+966112345678"],
  "emails": ["info@seerah.com.sa"],
  "website": "https://seerah.com.sa" }
```

- **`phones`** is every phone identifier the registry holds for the company, in E.164 (`+` and country code, no spaces), in the order they were recorded, so the first is the longest known. `[]` when there is none.
- **`emails`** is every email identifier, lower-case, in the order recorded. `[]` when there is none.
- **`website`** is `https://` and the company's oldest domain identifier: a registrable domain, with no `www.` and no path. `null` when there is none. A company on a shop builder or a social network only (Salla, Instagram) has no domain identifier, so no website.
- **Merges.** Contacts are the company's as it is now: a result whose company was merged into another shows the survivor's phones, emails and website. `company`, `city` and the rest stay as today.
- **The fields are always present**, empty or not, on `GET /v1/discovery/searches/:id/results` and on every line of `GET /v1/discovery/rfq-searches/:id/results`.
- **`why` is unchanged**, including the filter that drops a line carrying a URL, an email or a phone.

The registry reads them through one spine function, `companyContacts(tx, companyIds)`. It follows merges itself and answers for every id asked about. Discovery reads no other module's tables.

## Not in this step

- **Brief 26's hidden contacts stay hidden.** The buyers of a `discovery` audience, its previews, its campaigns' recipients, its messages and every webhook and event payload still carry no address. Unhiding them is its own decision.
- **Contacts on `GET /v1/discovery/searches/:id`, the lists and the webhooks.** Only the two results routes change.
- **Contacts the tenant stored itself.** Results read the shared registry, not the campaigns module's `contacts`. On staging every stored contact on a result company is already a registry identifier.
- **Telling a site's domain from an email's.** The registry derives a domain from a company email (`info@acme.com` gives `acme.com`) and keeps no note of which it came from. Discovery only keeps emails on a site it read, so this only matters for companies imported or sent through the API. One of 193 domains on staging comes only from an email.
- **The Maps id, CR and VAT.** They stay out of every `/v1` discovery response.
- **A label, a type (mobile or landline) or a source per value.**

## Tests

1. **Shape.**
   - A suppliers search's result carries `phones`, `emails` and `website` with the seeded values, in E.164, lower-case and `https://` respectively.
   - A company with no phone, email or domain carries `[]`, `[]` and `null`.
   - The Maps id never appears.
2. **Every value, in order.** A company with three phones and two emails lists all of them, oldest first. A company with two domains shows the oldest as its website.
3. **Merges.** A result whose company was merged after ranking shows the survivor's contacts.
4. **Opt-outs.** A suppressed phone is still listed.
5. **Both sides.** A buyers search carries the fields, and so does every line of an RFQ search's results.
6. **Unchanged.** Brief 26's tests pass unmodified: no address in discovery-preview, audience previews, recipients, messages or events.

## Docs

- `docs/PORTAL.md`: the "contacts are never returned" rule becomes what a result carries, the example results gain the fields, and the found-buyers section says audiences still never show which address the engine uses.
- `docs/API.md`: the portal result shape and the format of each field.
- `docs/ARCHITECTURE.md`: roadmap row 27.
