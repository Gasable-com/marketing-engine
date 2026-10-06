# Brief 20 — Read, extract and rank

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. After step 19 each task has kept candidates: companies that look like one of the job's personas, judged from search results alone. This step does the rest:
- reads their websites;
- has Claude extract what each company is, with a quote for every fact;
- checks every quote against the page it came from;
- saves the companies to the shared pool through `registry.upsert`;
- ranks the job's results, for **buyers and suppliers**, by how well each company fits a persona, with the quoted evidence shown.

Reading uses the self-hosted Firecrawl, with a guarded plain fetch as the fallback. **No raw page is stored.** Pages live in memory for one candidate at a time, and only checked quotes survive.

## One resumable stage: `read_extract` (per task)

Reading and extracting are one stage. Pages are not stored, so a separate extract stage would have nothing to work on after a retry. The stage takes the kept candidates in triage order, one at a time, and for each one:
1. reads its pages into memory;
2. extracts, checks the quotes and saves;
3. marks the candidate (`extracted`, `not_saved` or `failed`) before moving on, and drops the pages.

A retry or deferral resumes at the first kept candidate not yet marked, and reads its pages again. Migration `0019_discovery_extract.sql` widens `discovery_candidates.status` with `extracted`, `not_saved` and `failed`.

A candidate whose read or extraction fails with any error other than `UsageLimitError` or `PermanentError` is marked `failed` with a reason, and the stage continues. Only those two errors leave the stage.

Caps per job and task, so a job cannot exhaust the Claude seat the sales crons share:
- `DISCOVERY_MAX_READS` per task (default 10);
- `DISCOVERY_MAX_CLAUDE_CALLS` per job (default 40, across planning, triage and extraction, checked before each call);
- candidates past a cap are counted `reads_capped` or `extract_capped`, and the stage ends normally.

### Which candidates are read

- **Fresh.** A kept candidate whose company was profiled from the web within 90 days is not read or extracted. It is ranked with its triage persona and fit, no evidence, and the reason `profile fresh: not re-read`.
- **Maps-only.** A candidate with no website is not read. Its listing alone goes to extraction.
- **Everyone else.** The home page is read, plus at most 3 more pages from the same registrable domain whose links look like products, about or contact pages (`/products`, `/about`, `/contact`, `من نحن`, `منتجات`, `اتصل بنا`). Product, about and contact pages come first.
- **Size.** Each page's text is capped at 20 000 characters, and a candidate's pages at 40 000.

### Guarded reading

- **Address check.** Before any read, the host is resolved (all addresses). The read is refused if any address is in 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/4 and above, ::1, fc00::/7, fe80::/10, or the IPv4-mapped forms of these.
- **Firecrawl.** `POST $FIRECRAWL_URL/v1/scrape` with `formats: ["markdown"]`, `onlyMainContent: true` and a 30 s timeout. A page is used only when its final URL (`metadata.url`, else `metadata.sourceURL`) is on the candidate's registrable domain and resolves to a public address. Anything else is `read_failed: left the domain`.
- **Plain fetch.** Used when `FIRECRAWL_URL` is unset or a scrape fails.
  - It uses `node:http`/`node:https` with a `lookup` that resolves once, applies the address check, and connects to the address it checked.
  - Redirects are handled by hand, at most 3, and every hop must stay on the candidate's registrable domain and pass the address check.
  - The body is read as a stream and aborted at 2 MB, with a 15 s timeout.
  - HTML is turned into text by stripping tags, in a few lines, with no dependency.
- Blocked and shared hosts are never fetched.
- Firecrawl runs inside `infra_infra`, and its own redirect and DNS handling is a residual risk. `FIRECRAWL_URL` stays unset on prod until Firecrawl runs on a network with no internal services. The PR says so.

Counts: `read`, `read_skipped_fresh`, `read_failed`, `reads_capped`, `firecrawl`, `fetch_fallback`.

### Contacts by pattern

The following are found from the page text and the Maps listing, without Claude:
- phones (`libphonenumber-js`, with the task's country as default);
- emails;
- WhatsApp links (`wa.me/<number>`);
- for `SA`, CR numbers: 10 digits starting `1`–`5` or `7`, next to `CR`, `C.R`, `سجل تجاري` or `س.ت`.

These are verbatim matches, so they need no quote check.

### Extract

One Claude call per candidate through the bridge (`sonnet`). It is given, as data, the identified product, the side, the personas (with their signals numbered), the Maps listing, and the pages' text with each page's URL:
```json
{ "isCompany": true,
  "name": { "value": "Al-Falah Ready Mix", "quote": "…", "url": "…" },
  "nameAr": { "value": "مصنع الفلاح للخرسانة الجاهزة", "quote": "…", "url": "…" },
  "personaId": "…", "fit": "strong" | "weak" | "none",
  "evidence": [ { "signal": 0, "claim": "produces high-strength concrete", "quote": "…", "url": "…" } ],
  "products": [ { "value": "ready-mix concrete C60", "quote": "…", "url": "…" } ],
  "roles": ["manufacturer"],
  "cities": [ { "value": "Riyadh", "quote": "…", "url": "…" } ] }
```
- **Every quote is checked** against the text of the page its `url` names. The quote must be present after folding whitespace and Arabic marks (`foldText`), and be at least 12 characters long.
- **URLs and personas are checked too.** `url` must be exactly one of the URLs read for this candidate, or the listing's cid for Maps-only. `personaId` must be one of the job's personas.
- **What gets dropped:**
  - a fact that fails a check is dropped and counted in `quotes_dropped`;
  - an unknown `personaId` drops the candidate;
  - a candidate whose name has no checked quote (or, Maps-only, does not match the listing title) is marked `not_saved: no checked name`;
  - `isCompany: false` or `fit: none` marks it `not_saved` with Claude's reason, cut to 120 characters.
- **Roles** outside `PROFILE_ROLES` are dropped.

Counts: `extracted`, `quotes_checked`, `quotes_dropped`, `saved`, `not_saved`, `extract_failed`, `claude_calls`.

### Save

Each extracted company goes into the pool through `registry.upsert`, the only way in:
- **Source.** `source.type` is `web`, or `maps` for a Maps-only company. `source.tenantId` is the job's tenant (required), so the provenance is visible only to that tenant. `source.ref` is the URL or cid. `source.data` is `{ jobId, personaId, url, quotes, crClaimed? }`, with only checked quotes and never page text.
- **Identifiers:** the registrable domain, `gmaps`, phones and emails.
- **The CR is not an identifier.** A page can print anyone's CR, and a CR is strong, so it could attach the page's domain to a real company or merge two real ones. A CR found on the page is kept as `crClaimed` in the source data. It becomes an identifier only when Wathq (when configured, through `enrich`) returns a name that matches the checked name.
- **No name linking.** Web and Maps saves call `upsert` with a new option, `linkByName: false`. The default is `true`, so other callers are unchanged. A web company joins an existing one only through a strong identifier, never by a similar name.
- **The profile is merged, not replaced.** `setProfile` gains a `merge: true` mode:
  - `products`, `cities`, `countries` and `roles` are unioned with what is stored, deduplicated by `foldText`, with `products` capped at 50;
  - `quality` only goes up (`thin` never replaces `full`);
  - `sector` is not written from a persona guess;
  - `profiled_at` becomes now;
  - quality is `full` when a name, a product and a contact were all checked, `thin` otherwise.

## Rank by persona fit (`rank` changes)

A task's results are now in two tiers.

**1. Companies this task found** — extracted or fresh, kept by triage:
- score: `0.6` for a `strong` fit or `0.3` for a `weak` one;
- plus `0.2` × (distinct signal indexes among the checked evidence) ÷ (the persona's number of signals);
- plus the step-17 quality and freshness weights;
- reasons: `persona: Ready-mix concrete plants`, then each checked evidence line as `"<quote>" — <url>`, then the profile reasons.

**2. Pool matches** that this task did not find, scored as in step 17 and always ranked below tier 1:
- for suppliers, the `products` finder with the identified aliases;
- for buyers, the `products` finder with the personas' `placesTerms` (short kinds of company, never the product), over profile `products`.

Buyers jobs are ranked now; step 18's `skipped_rank_buyers` goes away.

Migration 0019 gives `discovery_results` `persona_id uuid null` and `evidence jsonb not null default '[]'` (checked quotes with URLs).

## API and dashboard

- **Results route.** `GET /internal/discovery/jobs/:id/results` rows add `persona` (`id`, `name`), `fit`, `evidence` (`claim`, `quote`, `url`) and `tier` (`found` | `pool`).
- **Results on the job page.** Each result shows its persona and each quote. A quote's link is drawn only for an `http(s)` URL.
- **Candidates table.** It shows each candidate's mark (`extracted`, `not_saved`, `failed`) and reason.
- **Counts.** They show reads, extractions, quotes checked and dropped, and saved.

## Tests (`test/discovery-extract.test.ts`)

There is no network in CI. Firecrawl and the plain fetch answer from saved pages in `test/fixtures/pages/`: small text files, at most 20 KB each, trimmed from real pages. DNS answers come from a stub. The bridge is the fake runner.

1. **Empty pool.** From saved search results and pages, an empty pool ends with the four expected diesel suppliers:
   - saved with checked quotes, `source_type = 'web'` and `source.tenantId` set;
   - with `crClaimed` on the one whose page shows a CR, and no CR identifier;
   - ranked in tier 1 with persona reasons and evidence.
2. **Bad facts.**
   - A made-up quote is dropped and counted.
   - A fact with no quote is dropped.
   - A URL that was not read, or `javascript:`, is dropped.
   - An unknown `personaId` saves nothing.
3. **Maps-only.** A Maps-only company is saved with its phone and `gmaps`, with `source_type = 'maps'` and quality `thin`.
4. **Freshness.** A company profiled from the web 30 days ago is not re-read and is ranked with its triage fit. One profiled 120 days ago is re-read.
5. **Buyers.** A buyers job for microsilica saves the ready-mix plant with `fit: strong` evidence and ranks it above a pool company matched only by a persona's Maps term. No microsilica seller appears.
6. **Resuming.**
   - A usage limit during candidate 3 defers the task. The resumed run starts at candidate 3, re-reads its pages, and does not re-extract candidates 1–2.
   - One bridge `504` among three candidates still saves the other two.
7. **Guarded reading.** These are never connected to, by the plain fetch or through Firecrawl's reported final URL:
   - a redirect to `169.254.169.254`;
   - a host resolving to `172.18.0.1`;
   - `http://[::ffff:127.0.0.1]/`;
   - a redirect off the candidate's domain.
8. **Pool safety.** A page printing an existing pool company's CR, or its exact name under a new domain, saves a new company and leaves the pool company's identifiers unchanged.
9. **Profile merge.** A company found by an SA task and then by an AE task keeps both countries and its earlier products, and its quality never drops.
10. **No page text** appears in `company_sources.data` beyond checked quotes, in `discovery_results`, in `discovery_tasks.error`, in `discovery_jobs.error`, in any `events.payload` or in any log line.
11. **Tenants.** Another tenant reads no `web` or `maps` source row the job wrote.
12. **Missing providers.** Without `FIRECRAWL_URL`, the plain fetch is used. Without the bridge, the job runs as in step 18.

## Done when

- CI passes.
- From saved pages, an empty pool ends with the expected companies saved and ranked with checked quotes, a made-up quote is dropped, a page's CR never merges companies, and a Maps-only company is saved with its phone.
- On staging, the `Microsilica MS900D  1 MT` buyers search for `SA` ends with ranked companies in the dashboard, each with its persona and quoted evidence.
- `docs/API.md` documents the new fields and counts.
- Row 20 is marked done.

## Do not

- Store raw pages, page text or HTML anywhere, including logs, errors and events.
- Fetch anything outside the candidate's own registrable domain, on a non-public address, or on a blocked or shared host.
- Save a company except through `registry.upsert`, or a fact except with a checked quote or a verbatim pattern match.
- Pass a CR from a web page to the registry as an identifier.
- Add a dependency. HTML to text takes a few lines, and there is no parser library.
- Build review actions (step 21).

## Report back

PR titled `20 read extract rank`, not merged. The description includes:
- the CI output;
- the live staging run's counts, Claude calls and total input characters;
- the live run's top five results with their evidence;
- how many quotes were dropped live, and why, briefly;
- anything in the code that made this brief wrong, and what you did instead.
