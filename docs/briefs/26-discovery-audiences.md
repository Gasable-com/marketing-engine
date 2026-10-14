# Brief 26 — Found buyers as an audience: outreach campaigns from portal discovery

Asked for on 2026-10-14 by the supplier portal. A supplier who ran **Find buyers** (brief 23) picks one or several of its finished searches. It turns the companies found into an **audience** and sends a campaign to it, using the existing campaign flow.

Decided (product owner):
- Found buyers are contacted as **outreach**. A campaign to them does **not** need recorded marketing consent.
- **Opt-outs still win.** Suppression (platform and tenant), the unsubscribe text and List-Unsubscribe, sending windows and quiet hours, and the campaign throttle all apply as they do today.
- **The portal user still never sees contacts.** No phone, email, Telegram id or domain appears in any `/v1` response or tenant webhook about these audiences, their previews, their campaigns' recipients or their messages.
- **A company found in several searches is one buyer and one recipient.**
- **Channel works as on any campaign.** The portal sends `channel: null` ("best available"), so selection picks per recipient.

## The audience

`audiences.kind` gains `discovery` (migration `0026_discovery_audiences.sql`).

```json
{ "name": "Buyers: Calcium Hypochlorite + 2 more", "kind": "discovery",
  "definition": { "requesterRef": "…", "searchIds": ["…", "…"],
                  "fit": ["strong"], "excludeCompanyIds": [] } }
```

- **`requesterRef`** is required.
- **`searchIds`** takes 1–20 product searches. Each must belong to this tenant and this requester, and be `done`.
  - A search that is missing or belongs to another requester gives `400 search_not_found { ids }`.
  - A search that is not finished gives `400 search_not_done { ids }`.
- **`fit`** is `["strong"]` (the default) or `["strong", "possible"]`.
- **`excludeCompanyIds`** is optional. It lists buyers the supplier unticked.
- `PATCH` may change `name` and `definition`, with the same checks.
- In `GET /v1/audiences`, `members` is `null`, as for a search audience.

**Resolution** happens every time the audience is used (a preview, or each campaign run), as with a search audience:

1. **Companies.** Take the union of the searches' ranked results whose `fit` is in `fit`, after following merges to the survivor and de-duplicating. Drop `excludeCompanyIds` and companies now on-platform.
2. **One outreach contact per company.** Upsert one tenant contact per company, holding the company's best phone and best email from its registry identifiers.
   - Set `company_id`, set `name` to the company name, and set the new column `contacts.hidden = true`.
   - If the tenant already holds one of those addresses as a normal contact, reuse that contact unchanged.
   - Many phones or emails on one company never become many recipients.
3. **The audience is those contacts.** A company with no phone and no email contributes nothing and is counted as `unreachable`.

## Hidden contacts

- Not listed by `GET /v1/contacts`. `GET`, `PATCH` and `POST /v1/audiences/:id/members` by id answer as if the contact were unknown.
- Never picked by a `search` audience's `contactFilter`. They cannot be members of a `static` audience.
- Wherever a hidden contact appears, `phone`, `email` and `telegram` are `null` and `company: { id, name }` is added. That covers previews, `GET /v1/campaigns/:id/runs/:runId/recipients`, `GET /v1/messages/:id`, and tenant webhook and event payloads.
- If the tenant later stores the same address itself (`POST /v1/contacts` or an import), that contact becomes a normal, visible contact, because the tenant brought the address.

## Outreach purpose

`PURPOSES` gains **`outreach`**.

- **`can_send`.** Suppression first, unchanged. **No consent check for `outreach`**, as for `transactional`. Region and sending rules that apply to `marketing` also apply to `outreach`: Saudi sending windows, registered sender IDs and the mandatory unsubscribe text. The exception is the "no marketing to unconsented numbers" row.
- **Opting out.** An unsubscribe, STOP or complaint on an outreach message writes a tenant suppression, exactly as for marketing. The next run blocks that buyer with `suppressed`.
- **Pairing.** `outreach` is only allowed on a campaign whose audience is `discovery`, and a `discovery` audience only takes `outreach` campaigns. Anything else is `400 purpose_mismatch`. `POST /v1/messages` with `outreach` is `400 purpose_not_allowed`
- **Runs.** Runs snapshot the audience as today. A recurring outreach campaign re-resolves on each run.

## Preview before saving

`POST /v1/audiences/discovery-preview` (tenant JWT):

```json
{ "requesterRef": "…", "searchIds": ["…"], "fit": ["strong"], "excludeCompanyIds": [] }
→ 200 { "companies": 86, "reachable": 64, "unreachable": 22,
        "buyers": [ { "company": { "id", "name" }, "city", "country", "fit", "rank",
                      "searchIds": ["…"], "reachable": true } ] }
```

- It uses the same checks and errors as creating the audience, and saves nothing.
- `buyers` is the whole de-duplicated list (at most 20 searches × their result limit), best rank first. There are no addresses, only `reachable`.
- The portal uses it while the supplier is picking searches, and again to list an existing audience's buyers, by passing that audience's definition.
- `POST /v1/audiences/:id/preview` on a `discovery` audience works as today (with addresses `null`) and adds `companies`, `reachable` and `unreachable`.

## How the portal will call it

The portal proxy sets `requesterRef` from the session, never from the browser, as it does for discovery. It forwards only these new calls:

| Route | What |
| --- | --- |
| `POST /v1/audiences/discovery-preview` | Counts and buyers while picking |
| `POST /v1/audiences` with `kind: "discovery"` | Create |
| `GET` / `PATCH` / `DELETE /v1/audiences/:id` | As today |
| `POST /v1/audiences/:id/preview` | As today, with no addresses |
| `POST /v1/campaigns` with `purpose: "outreach"` | Then schedule, pause and the rest as today |

## Not in this step

- Showing contacts to the supplier.
- A reply path or an invite link to ENTEK.AI.
- Per-buyer frequency caps across campaigns.
- Audiences from corporate RFQ searches.

## Tests

1. **Resolution.**
   - Two searches sharing a company give one contact.
   - `fit` and `excludeCompanyIds` filter.
   - An on-platform company drops out.
   - A merged company follows its survivor.
   - A company with five phones gives one recipient.
   - A company with no phone or email counts as `unreachable`.
2. **Requester.**
   - Another requester's search gives `400 search_not_found`.
   - A running search gives `400 search_not_done`.
   - 21 searches gives `400`.
3. **Hidden.**
   - `GET /v1/contacts` does not list them.
   - Preview, recipients, `GET /v1/messages/:id` and webhook payloads carry no address.
   - Search and static audiences never include them.
   - `POST /v1/contacts` with the same phone makes the contact visible.
4. **Outreach.**
   - With no consent the send is allowed.
   - A suppressed address is blocked.
   - A quiet hour defers the send.
   - An unsubscribe writes a suppression, and the next run blocks that buyer.
   - The unsubscribe text is appended.
5. **Pairing.**
   - `outreach` on a static audience gives `400 purpose_mismatch`.
   - `marketing` on a discovery audience gives `400 purpose_mismatch`.
   - `POST /v1/messages` with `outreach` gives `400`.
   - A discovery audience with no purpose defaults to `outreach`.
6. **Preview.** `discovery-preview` counts equal the created audience's preview counts.

## Docs

- `docs/PORTAL.md` gains **Supplier: found buyers as an audience**: pick searches, preview, create, send an outreach campaign, with examples.
- `docs/API.md`: the `discovery` audience kind, `discovery-preview`, `outreach`, hidden contacts and the new errors.
- `docs/ARCHITECTURE.md`: the consent row notes that `outreach` skips consent but never suppression.
