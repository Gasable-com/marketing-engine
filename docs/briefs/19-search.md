# Brief 19 — Search for the personas

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. Step 18 gave every job three things: an identified product, a side (suppliers or buyers), and 3–6 personas, each with search terms, Maps keywords and website signals. This step searches the web and Google Maps for those personas in each of the job's countries, and keeps the hits that look like real companies of a persona. It reads no websites (step 20) and saves nothing to the pool.

Search is Serper, which is decided:
- web results come through `/search`, Maps listings through `/places`;
- staging uses the engine's own test key (`SERPER_API_KEY`), never the sales team's key;
- the key has a low rate limit (5/s) and a fixed number of credits (2,500), so every query is throttled, counted, cached and capped.

## Part A — Architecture amendment (first commit after the brief)

`search_queries` becomes a third shared table next to `companies` and `company_identifiers`.
- In the Discovery section of `docs/ARCHITECTURE.md`, add: "`search_queries` is a shared cache of trimmed public search results: no tenant data, no RLS, written and read only by the discovery search adapter."
- In `CLAUDE.md` rule 3, name it as shared next to the prospect-pool tables.

## Serper adapter (`src/modules/discovery/search/serper.ts`)

- **Calls.** `searchWeb({ q, gl, hl, page })` and `searchPlaces({ q, gl, hl })`, with plain `fetch` to `https://google.serper.dev` and the key in `X-API-KEY`.
- **Throttle.** One in-process token bucket at `SERPER_RPS` (default 4).
- **Trimmed results only:**
  - web: `{ title, link, snippet, position }`;
  - places: `{ title, address, phoneNumber, website, cid, placeId, category, rating, ratingCount }`;
  - nothing else from the response is kept.
- **Errors:**
  - A body mentioning credits (`Not enough credits`, which Serper sends as `400`), any other `400`, and any `401`, `402` or `403` throw `PermanentError("search provider refused: <message>")`. The task fails at once, through step 18's mechanism.
  - `429` and `5xx` throw a plain error, which is retried with backoff.
- **Optional.** `search` and `triage` need both `SERPER_API_KEY` and `CLAUDE_RUNNER_URL`. With either unset both stages are skipped (`skipped_search: 1`, `skipped_triage: 1`) and the job ranks as in step 18.

## Cache (`search_queries`, migration `0018_discovery_search.sql`)

- **Columns:** `id bigserial pk`, `provider text`, `kind text check (kind in ('web', 'places'))`, `q text`, `gl text`, `hl text`, `page int`, `results jsonb` (the trimmed list), `result_count int`, `fetched_at timestamptz`; `unique (provider, kind, q, gl, hl, page)`.
- **No RLS.** `marketing_app` gets select, insert and update. Pruning runs as the owner.
- **Reuse.** A query fetched within `SEARCH_CACHE_DAYS` (default 30) is answered from the table, with no Serper call.
- **Pruning.** `pruneSearchCache()` in `src/modules/discovery/search/cache.ts` deletes rows fetched more than 90 days ago. It is registered in `src/jobs/index.ts` as its own `discovery.cache.prune` schedule (`30 * * * *`).
- **Size.** A query's results are a few kilobytes. Nothing larger is stored.

## Rule kinds

Two new kinds in `rules`, read through the existing evaluator. Migration 0018 inserts `('AE', 'Asia/Dubai')` into `regions` first.

**`discovery.country`** is a value rule:
- It is read with `rules.decide({ kind: 'discovery.country', tenantId, region: <task country>, context: {} })`.
- It is seeded as region-scoped rows, one per country, for `SA` and `AE`.
- Each document is `{"if": [true, { gl, hl, languages, cities, suffix }, null]}`, and no nested object in it has exactly one key. For example: `cities: ["Riyadh", "Jeddah", "Dammam", …]`, `suffix: { en: "Saudi Arabia", ar: "السعودية" }`.
- A country with no row gets `null`, and searches with `gl` set to the code, in English only.

**`discovery.blocked_hosts`** is a deny rule:
- It is checked once per candidate domain with `rules.evaluate({ kind: 'discovery.blocked_hosts', tenantId, region: <task country>, context: { host } })`.
- Each row's document is `{"in": [{"var": "host"}, ["…", "…"]]}`.
- The platform row holds a seeded list of directories, marketplaces, news sites and job boards.
- A tenant adds hosts with a row of its own. Any denying row wins, so tenants add to the platform list and can never lift it. Step 21's "block a domain" writes a one-host tenant row.

## Queries (`search` stage, per task)

For each persona of the job, in order:
- **web:** each `searchTerms` entry, once as written and once with the country's suffix in the term's language;
- **places:** each `placesTerms` entry, plus `<term> <city>` for the country's first three cities.

The queries are capped:
- `DISCOVERY_MAX_QUERIES` per task (default 30);
- `DISCOVERY_MAX_QUERIES_PER_JOB` (default 60), counted across the job's tasks;
- personas take turns, so none is starved;
- what either cap dropped is counted in `queries_capped`.

Each query goes through the cache. Counts: `queries`, `serper_calls`, `cache_hits`, `hits`.

## Candidates (`discovery_candidates`, migration 0018, tenant RLS)

Hits become candidates, grouped so that one company is one candidate:
- **Web hits** are grouped by registrable domain (`normalizeDomain`). A hit on a shared host is dropped (`shared host`), unless it is a Maps listing. A hit the `discovery.blocked_hosts` rule denies is dropped (`blocked host`).
- **Places hits** are grouped by cid (`gmaps`), then merged into the web candidate with the same website domain.
- **Registry matching.** Each candidate is matched with `registry.findByIdentifier` on the registrable domain, then on `gmaps`, with values normalised by `normalizeIdentifiers`. A match sets `company_id`. Phone is weak and never sets `company_id`; a phone hit is only noted in `reason`.

Columns:
- `id uuid pk`, `tenant_id`, `job_id`, `task_id`;
- `kind text check (kind in ('web', 'maps', 'both'))`;
- `domain text null`, `gmaps text null`, `name text`, `url text null`, `phone text null`, `address text null`, `category text null`;
- `snippets jsonb`: at most 5 `{ query, title, snippet }`;
- `persona_ids uuid[]`;
- `fit text null check (fit in ('strong', 'weak'))`;
- `company_id uuid null references companies`;
- `status text check (status in ('new', 'kept', 'dropped'))` (step 20 widens it), `reason text null`;
- `created_at`.

There is a unique index on `(task_id, domain)`, and one on `(task_id, gmaps)`, each where the column is not null. A re-run of a task replaces its candidates.

## Triage (`triage` stage, per task)

Claude decides, through the bridge, which candidates are companies of a persona. It does no reading; it works only from names, snippets, addresses and Maps categories.
- **Input.** Batches of up to 40 candidates per call, sent in `input` as a JSON array of `{ id, name, snippets, address, category, profile }`. `profile` holds the stored `products`, `roles` and `cities` when the candidate is already in the registry, and is null otherwise. The batch comes with the identified product, the side and the personas (ids, names, descriptions, signals).
- **Output.** The schema requires exactly one `{ id, verdict: "keep" | "drop", fit: "strong" | "weak" | null, personaIds, reason }` per id sent. The reason is cut to 120 characters, for example `directory listing`, `news article`, `sells cars, not admixtures` or `likely a ready-mix plant`.
- **Bad batches.** A batch with missing, extra or duplicate ids, or with persona ids not in the job, is retried once. After that its candidates are counted `triage_failed` and left `new`.
- **Stage errors.** A batch failing with any other error is handled the same way. Only `UsageLimitError` and `PermanentError` leave the stage.

Counts: `candidates`, `kept`, `dropped`, `triage_failed`, `claude_calls`.

`rank` still ranks the pool for suppliers jobs, as in step 18, and stays skipped for buyers jobs. Step 20 makes it rank what was found.

## API and dashboard

- **Route.** `GET /internal/discovery/jobs/:id/candidates?country=&status=` (paged) returns name, kind, domain, gmaps, url, phone, address, category, snippets, personas (ids and names), fit, status, reason and `companyId`.
- **Candidates table.** The job page gets one under results. Kept candidates come first, with their persona, fit and Claude's reason. Dropped ones are behind a toggle.
- **Counts.** Task counts show queries, Serper calls, cache hits, candidates and kept.

## Tests (`test/discovery-search.test.ts`)

Serper is never called in CI. The adapter's `fetch` is replaced with one answering from saved responses in `test/fixtures/serper/`: small, trimmed JSON, a few KB each. The bridge is the fake runner from step 18. `resetDb()` truncates `search_queries` and `discovery_candidates`, so every test starts with an empty cache.

1. **A suppliers task** for diesel in `SA`, with two personas, yields the expected candidates:
   - grouped by domain, with a Maps listing merged into its website's candidate;
   - a Salla page dropped as `shared host`, and a directory dropped as `blocked host`;
   - triage verdicts, fits and reasons recorded.
2. **A buyers task** for microsilica in `SA` keeps the ready-mix plants and drops the news article.
3. **A re-run** of the same task makes **no** Serper calls (`serper_calls: 0`, all `cache_hits`), and replaces the candidates rather than adding to them.
4. **Serper errors.** An exhausted key (`400 {"message":"Not enough credits"}`) fails the task at once with `search provider refused: …`, with no retries. A `429` is retried.
5. **Caps.** The per-task and per-job query caps hold, `queries_capped` says how many were dropped, and personas take turns.
6. **Rules.** An `AE` task gets AE's cities and suffix. A host in a tenant's `discovery.blocked_hosts` row is dropped, and a platform-blocked host stays dropped.
7. **Triage failures.** A triage answer with a missing id is retried once, then counted `triage_failed`. One failing batch out of two leaves the other batch's verdicts.
8. **Registry.** A candidate whose phone matches a pool company gets no `company_id`, and its domain match does.
9. **Missing providers.** With `SERPER_API_KEY` set but the bridge unset, no Serper call is made and the job runs as in step 18.
10. **Tenants.** Candidates are tenant-scoped; the cache is not.

## Done when

- CI passes.
- From saved Serper responses, a buyers task and a suppliers task yield the expected candidates with reasons, a re-run makes no Serper calls, and an exhausted key fails the task with a reason.
- One live staging search (diesel, SA, suppliers) shows kept and dropped candidates on the job page, and the task counts show the Serper calls it spent.
- `docs/API.md` documents the candidates route, the counts and the two rule kinds.
- Part A is in, and row 19 is marked done.

## Do not

- Read any website or save anything to the pool (step 20).
- Use the sales team's Serper key, SearXNG, Firecrawl search or any other search source.
- Store anything from Serper beyond the trimmed fields.
- Exceed the throttle or the caps, or make a Serper call the cache could answer.

## Report back

PR titled `19 search`, not merged. The description includes:
- the CI output;
- the live search's counts (queries, Serper calls), and the credits left before and after from `GET /account`;
- what triage kept and dropped on the live run, briefly;
- anything in the code that made this brief wrong, and what you did instead.
