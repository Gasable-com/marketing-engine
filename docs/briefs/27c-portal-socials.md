# Brief 27c — Social profiles on portal search results

Asked for on 2026-10-21 by the product owner: socials are collected now (brief 27b) but not shown in the supplier portal, so "send them like we did the contacts" (brief 27).

This supersedes the line in brief 27b that says "the portal gets nothing". A company's social profiles are links it publishes, so they go where its phones, emails and website already are.

Decided (product owner, 2026-10-21):
- **Portal results carry a company's social profiles**, from the registry, as brief 27 did for its contacts.
- **Same scope as brief 27.** Both results routes, both sides, every RFQ line.

## The result

A result in the portal view gains one field, beside `phones`, `emails` and `website`. Nothing else changes.

```json
"socials": { "linkedin": ["https://linkedin.com/company/seerah-pools"],
             "instagram": ["https://instagram.com/seerahpools", "https://instagram.com/seerah.ar"] }
```

- **The shape is `groupSocials`'s, as on `GET /v1/companies/:id`.** An object keyed by network, in the order `linkedin`, `instagram`, `x`, `facebook`, `tiktok`, `youtube`, `snapchat`. It has keys only for the networks the company has a profile on.
- **Each value is a list of links**, `https://` and the canonical form of brief 27b (no `www.`, lower-case), in the order recorded.
- **`{}` when none is held.** The field is always present.
- **Merges** follow the survivor, as for the contacts: `companyContacts` reads `social` rows too.
- A company read before brief 27b has `{}` until its site is read again (no backfill; brief 27b).

## Not in this step

- Socials on `discovery-preview`, audiences or anything else brief 26 keeps addressless. A profile link is not an address the engine sends to, but nothing there asked for it.
- A per-profile label, follower count or "verified" flag.

## Tests

1. A result's `socials` group every profile by network, LinkedIn first, in the order recorded, from the canonical forms (`sa.linkedin.com/company/…/about?trk=…`, `twitter.com/…`, `www.instagram.com/…/`).
2. A company with none carries `{}`, and the field is on every result.
3. A result merged away since it was ranked shows the survivor's profiles.
4. Brief 27's and brief 26's tests pass unchanged.

## Docs

- `docs/PORTAL.md`: `socials` in the contact fields and the example result.
- `docs/API.md`: `socials` in the portal result shape.
- `docs/ARCHITECTURE.md`: roadmap row 27c, and row 27b no longer says the portal gets nothing.
