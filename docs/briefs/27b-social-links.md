# Brief 27b — Social profiles of found companies, LinkedIn first

Asked for on 2026-10-21: "why do the searches not get LinkedIn and socials of companies?" The goal is to collect a found company's social profiles, with LinkedIn the one that matters most.

## Why nothing is found today

Three gaps, measured on 2026-10-21 against the staging Firecrawl with `https://www.gasable.com`:

1. **The site reader never sees the footer.** The scrape asks Firecrawl for `onlyMainContent: true`, which strips header, nav and footer before it derives `links`. The home page came back with 11 links and no social profile. The same scrape with `rawHtml` added carried all five (LinkedIn, Instagram, X, Facebook, YouTube) in the footer, with the markdown unchanged (5.1k characters). Asking for `onlyMainContent: false` instead would find them too, but triples the text Claude reads (15.2k characters) and eats the 40k-character candidate cap before the product pages are reached. The plain-fetch fallback already reads the whole page, so it only suffers from the next two gaps.
2. **The links are thrown away.** `choosePages()` keeps links on the company's own domain that look like product, about or contact pages and drops the rest; `htmlToText` keeps only `mailto:`, `tel:` and WhatsApp targets in the text.
3. **There is nowhere to put them.** `contactsIn()` finds phones, emails, WhatsApp numbers and CRs; identifier types are `cr`, `vat`, `domain`, `phone`, `email`, `gmaps`. A LinkedIn result from Serper is dropped as a `shared host`, by design: a URL on `linkedin.com` says where a company has a page, not which company it is.

## What changes

**1. Identifier type `social`, weak.** Migration `0027_social_identifiers.sql` adds `social` to `company_identifiers_type_check`. Nothing else in the schema changes; `unique (type, value)` and the company index already cover it. The value is the profile's canonical form, no scheme, lower-cased:

| Network | Canonical value | Taken from | Never taken |
| --- | --- | --- | --- |
| LinkedIn | `linkedin.com/company/<slug>` | any `*.linkedin.com/company/<slug>/…` (`sa.`, `www.`, locale subdomains dropped; anything after the slug dropped, so `…/company/gasable/mycompany/verification/` is `linkedin.com/company/gasable`) | `/in/` (a person), `/school/`, `/showcase/`, `/jobs/`, `/pulse/`, `/posts/`, `/feed/`, `shareArticle`, `/sharing/` |
| Instagram | `instagram.com/<handle>` | `instagram.com/<handle>` | `p`, `reel`, `reels`, `explore`, `accounts`, `stories`, `share`, `direct`, `tv` |
| X | `x.com/<handle>` | `x.com` and `twitter.com` | `intent`, `share`, `home`, `i`, `hashtag`, `search`, `login`, `signup`, `explore`, `settings`, `messages`, `privacy`, `tos` |
| Facebook | `facebook.com/<page>` or `facebook.com/profile.php?id=<n>` | `facebook.com`, `fb.com`, `m.`, `web.`, locale subdomains | `sharer`, `share.php`, `dialog`, `login`, `plugins`, `events`, `photo`, `photos`, `watch`, `hashtag`, `help`, `policies`, `privacy`, `tr` |
| TikTok | `tiktok.com/@<handle>` | `tiktok.com/@<handle>` | everything else (`/video/`, `/tag/`, `vm.tiktok.com`) |
| YouTube | `youtube.com/@<handle>`, `/channel/<id>`, `/c/<name>`, `/user/<name>` | those four forms | `/watch`, `/embed`, `/playlist`, `/shorts`, `youtu.be` |
| Snapchat | `snapchat.com/add/<handle>` | that form | everything else |

A link to one post (`x.com/<handle>/status/…`, `facebook.com/<page>/posts/…`, `/photos/`, `/videos/`, `instagram.com/<handle>/p/…`, `/reel/`) is refused, not reduced to its author: an embedded tweet is often another account's, and would give the company that account.

The table lives in one pure function, `canonicalSocial(url) → { network, value } | null`, in `src/spine/registry/socials.ts`, exported from the registry like `normalizeDomain`. `normalizeIdentifiers` gains `case 'social'` that calls it and rejects what it refuses (`not a social profile`). `STRONG_TYPES` is unchanged: a `social` links a company and never merges two, because a page can link its parent's, a franchise brand's or its web agency's profile, and a weak identifier already held by another company is left where it is, exactly as a phone is. `POST /v1/companies` accepts `{ "type": "social", "value": "https://www.linkedin.com/company/acme" }` and `GET /v1/companies?identifier=social:linkedin.com/company/acme` finds by it, with no route change.

*Alternative not taken:* one type per network (`linkedin`, `instagram`, …). Seven cases in the enum, the constraint and the normaliser for what one table row per network says; and "which network" is the first host label of the value anyway.

**2. The reader keeps every link, from the whole page.** The Firecrawl request becomes `formats: ['markdown', 'rawHtml'], onlyMainContent: true`: the text Claude reads is as today; the links are read from `rawHtml` by the same `linksIn()` the plain fetch uses, so one link reader serves both paths and Firecrawl's own `links` format and `linksOf()` go. The response stays under the same 2 MB cap (a page whose HTML is larger fails over to the plain fetch, which reads the same HTML under the same cap). `SiteRead` gains `links: Link[]`: every link of every page read, in read order, home page first. A side effect worth a test: `choosePages()` now also sees the nav menu on Firecrawl-read sites, which is where the products, about and contact links usually are.

**3. Socials by pattern, never by Claude.** `socialsIn(links)` in `src/modules/discovery/read/socials.ts`, beside `contactsIn`, runs `canonicalSocial` over the links and returns the distinct profiles per network in the order found, at most 3 per network (the first is the one the home page linked). Share buttons (`sharer.php`, `intent/tweet`, `shareArticle`) fall out by the table above. The extraction prompt and `checkExtraction` are untouched: socials need no quote, they are verbatim links, as phones are.

**4. One LinkedIn lookup when the pages gave none.** In `readAndExtract`, after the extraction passed and before the upsert, when Serper is configured, the pages yielded no LinkedIn, and the matched pool company (`c.company_id`, if any) holds none:

- one web query, `<name> site:linkedin.com/company`, `gl` from the country row, `hl: 'en'`, through `webSearch()` so the cache answers a repeat for nothing. The name is unquoted and stripped of a bracketed aside, a trailing branch (`Riyadh Branch`, `فرع الرياض`), punctuation and legal-form or trade words. *Changed after the first staging run (2026-10-21):* the quoted saved name found 1 page in 15 lookups, and 11 of them returned no hits at all, all Maps titles like `BRC COMPRESSORS - UNIVERSE WAY CO. Riyadh Branch` or `Diyar Al-ezz Compny`;
- recorded as `discovery.task.queried` exactly like a search query, with `personaId: null` and `lookup: 'linkedin'` in the payload, so it is on the spend log and `GET /internal/discovery/queries` can tell it apart;
- the first hit is taken whose link canonicalises to `linkedin.com/company/<slug>` **and** whose title, with its trailing `| LinkedIn` or `- LinkedIn` removed, is `sameName` to the saved name, **or** whose slug with hyphens as spaces is; the name with its aside and branch removed counts as the saved name too, and each side of a bilingual `A | B` title is read on its own. The page must also be placed in the country: some listing of the same page (Serper often lists one page once per LinkedIn country site) has, in its title or snippet, the company's read domain as a host name, a country name of more than one word, or a location as LinkedIn writes one, two of the country's names or cities either side of a comma (`Dammam, Saudi Arabia`), all from the `discovery.country` row. A lone word places nothing (`saudi` is in Saudi Aramco, `المملكة` is any kingdom, Medina is also in Ohio, `الخبر` is also "the news"), nor does the LinkedIn host (`sa.linkedin.com` serves every page, and a Saudi company showed up under `bo.`), nor a place word in the company's own name. *Added after the second staging check:* unquoted, "United Innovations Trading Company" (a Saudi tools shop) folded to the same name as United Innovations Inc of Tampa, Florida, which came first in the hits; No hit that passes is a miss, counted and nothing stored;
- a failed call (`search provider unreachable` or `failed`) is counted and the company is saved without; a `PermanentError` (key refused, out of credits) stops lookups for the rest of the task and the task carries on. A lookup never fails a candidate.

It applies to Maps-only companies too, by their listing name: those are exactly the ones with no site to read. Cost: at most one credit per company read, so bounded by `DISCOVERY_MAX_READS` per task; no new env var. No Claude call.

*Alternative not taken:* a separate `socials` task stage after `read_extract`. It would be resumable on its own, but `read_extract` already resumes at the candidate, and a stage is one more name in `TASK_STAGES`, `stages_done` and the counts for one query per company.

**5. Saved with the company.** The `social` identifiers go in the same `registry.upsert` as the phones and emails. The source's `data` gains `socials` (what the pages linked, canonical) and, when the lookup gave one, `linkedinLookup: { q, url, title }`, so the provenance of a LinkedIn that no page linked is on the record. Profile `quality` is unchanged: `full` still needs a phone or an email, because it says whether outreach can reach the company. Task counts gain `socials` (companies with at least one), `linkedin_pages` (LinkedIn from the pages), `linkedin_lookups`, `linkedin_found`, `linkedin_lookup_failed`.

Socials are collected when a company is read. A company already in the pool and not read (tier `pool`, or profiled within 90 days) keeps what it has until its next read.

**6. The API says it.** The engine groups; nobody parses values:

```json
"socials": { "linkedin": ["https://linkedin.com/company/acme"],
             "instagram": ["https://instagram.com/acme", "https://instagram.com/acme.ar"] }
```

Keys only for networks present, LinkedIn first, URLs with scheme so a screen can link them; built by one `groupSocials(identifiers)` in the registry.

- `GET /v1/companies/:id` and `?identifier=`: `identifiers` now includes `social` rows (as every type already is) and the response gains `socials`.
- `GET /internal/discovery/jobs/:id/results`: the identifiers subquery includes `social`; each row gains `socials`.
- `GET /internal/discovery/jobs/:id/results.csv`: columns `linkedin` and `socials` (all, `; `-joined) after `google_maps_ids`; both engine-normalised values.
- `GET /internal/discovery/queries` rows carry `lookup` (`null` or `linkedin`).
- The portal gets nothing: `docs/PORTAL.md` returns a result's phones, emails and website but no other identifier (no Maps id, CR or VAT), and a company's LinkedIn is an identifier.

**7. The dashboard renders it.** The Discovery results table's identifiers cell shows `socials` as links (`target="_blank"`, `rel="noopener"`), LinkedIn first, and still lists every other identifier as today. A search's page shows the new counts where the others are. Nothing is derived in the browser.

## Not in this brief

- A backfill over companies already in the pool: it means re-reading their sites. A later brief can add a `refresh` for companies with a domain and no `social`.
- Socials for companies with no site and no LinkedIn hit (an Instagram-only shop found through Maps). A `"<name>" site:instagram.com` lookup is the same mechanism and can follow once the LinkedIn hit rate is known from the counts.
- Telegram and WhatsApp links: they are contact channels, handled as contacts.
- People's profiles (`linkedin.com/in/…`): personal data, and not the company.
- Loosening the name match (trigram similarity, the domain in the snippet): first see how often the strict match misses, from `linkedin_lookups` against `linkedin_found`.
- A partial index for `type = 'social' and value like 'linkedin.com/%'`: the pool is small on both stacks.

## Done when

1. From saved pages, a suppliers task saves a company whose footer links LinkedIn (through an admin URL), Instagram, X (as `twitter.com`), Facebook (as `m.facebook.com`) and YouTube, as five `social` identifiers in canonical form, and the results row's `socials.linkedin` names it; its `sharer.php` and `intent/tweet` buttons are not identifiers; the Firecrawl path (from `rawHtml`) and the plain-fetch path find the same five, and Firecrawl's read now chooses the product page the nav menu links.
2. A company whose pages link no LinkedIn gets one `discovery.task.queried` event with `lookup: 'linkedin'` and the credits Serper said, the page from the saved Serper response whose title matches its name as a `social` identifier, and `linkedinLookup` on its source; a hit titled for another company is not taken and counts as a miss; a re-run of the task records the lookup as cached at zero credits.
3. A Maps-only company is looked up by its listing name. A Serper failure during a lookup leaves the company saved without LinkedIn and counts `linkedin_lookup_failed`; a refused key stops lookups for the task and the task still finishes.
4. The web agency's Instagram linked from two companies' footers stays with the first company and merges nothing; a `social` passed to `POST /v1/companies` is normalised, a person's profile and a share link are rejected as `not a social profile`, and `GET /v1/companies?identifier=social:…` finds the company.
5. The CSV carries `linkedin` and `socials`; the dashboard renders the links and the counts from fixtures.

## Tests

- `test/registry.test.ts`, normalisation: every row of the table above, including the gasable admin URL, `sa.linkedin.com/company/x?trk=…`, `twitter.com/Acme` → `x.com/acme`, `m.facebook.com/AcmeCo/` → `facebook.com/acmeco`, and the rejected forms; upsert: a weak `social` held elsewhere is left there.
- `test/discovery-read.test.ts`: `socialsIn` order, the 3-per-network cap and the share buttons; Firecrawl links from `rawHtml` (the fake Firecrawl answers with the fixture's HTML as `rawHtml`); a new fixture `test/fixtures/pages/social-home.html` with a nav menu and a footer of social links.
- `test/discovery-extract.test.ts`: points 1–4 above, with `test/fixtures/serper/web-linkedin.json` holding one matching and one wrong-company hit.
- `test/operator.test.ts` or `test/discovery-jobs.test.ts`: `socials` on the results route and the CSV columns.

## Docs

- `docs/API.md`: the `social` type and its canonical forms under Companies; `socials` on the company responses and the results rows; the CSV columns; `lookup` on the queried payload and the queries route; the step-20 paragraph gains the LinkedIn lookup.
- `docs/ARCHITECTURE.md`: the registry row lists `social` among the weak identifiers; the web discovery paragraph says socials come from the pages' links and LinkedIn from one Serper query; roadmap row 27.
- `docs/PORTAL.md`: unchanged, and the brief says why.
