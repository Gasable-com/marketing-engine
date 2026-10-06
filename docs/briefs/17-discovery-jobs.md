# Brief 17 — Discovery jobs

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This is the first of five steps (17–21) that add **web discovery**: an operator names a product and the countries to search, and gets back ranked supplier companies, each carrying evidence quoted from its website or Maps listing. Five decisions are already made:

- It is standalone. It does not link to the marketplace Admin Panel's supplier searches, imports nothing from them, and replaces nothing.
- Language work (search terms, triage, extraction) runs through Claude Code sessions on the host, through a small bridge built in step 18. **Nothing in this roadmap builds toward the Anthropic API.**
- Search is Serper (web and Places, step 19). Reading websites is the self-hosted Firecrawl (step 20).
- It runs on staging only for now. Every outside provider is optional by env, and with them unset the engine runs as before.
- Results are reviewed in the engine's operator dashboard (step 21).

This brief builds the base and calls **no outside service**:
- the architecture amendment
- the tables
- registry fixes that web data needs
- a `products` finder
- jobs and tasks on pg-boss
- operator routes to create and read jobs

A job ranks companies already in the pool. Steps 19 and 20 add stages that fill the pool from the web before ranking.

## Part A — Architecture amendment (first commit after the brief)

This step conflicts with `docs/ARCHITECTURE.md` as written ("Scope in v1: off-platform corporate buyers only"; outside providers are Wathq and messaging only). Amend it in one commit before any code:

1. **Discovery section.** After the existing paragraphs, add a paragraph headed **Web discovery (steps 17–21)** that says:
   - An operator creates a job for a product and one or more countries. The job runs one task per country on pg-boss. Each task passes through named stages: rank the pool now; later, search, triage, read and extract.
   - Results are private to the tenant the job was created for.
   - Companies found on the web or Maps enter the shared pool only through `registry.upsert`, with source `web` or `maps`. Every extracted fact carries a quote that is checked against the page it came from.
   - Serper (search), Firecrawl (reading pages) and the Claude bridge (language work) are optional providers set by env. Without them, a job ranks the existing pool only.
   - The Claude bridge is a small service on the host, in `ops/claude-runner/`, that runs Claude Code sessions with tools, MCP servers and settings disabled. It is not part of the engine image.
   - No raw pages are stored.

   Change the scope sentence to: "Scope: off-platform companies — buyers through the invite loop (step 6), suppliers through web discovery (steps 17–21)."
2. **`docs/DASHBOARD.md`, "What is not here".** Change "No write endpoints beyond retry and replay" to also allow the discovery operator actions: creating a search (this step) and reviewing results (step 21).
3. **Roadmap.** Add these rows after 16. Mark 17 done when this PR is ready.

| Step | Build | Done when |
| --- | --- | --- |
| 17. Discovery jobs | `discovery_jobs`, `discovery_tasks`, `discovery_results` (tenant RLS); one pg-boss task per country, run as named stages; the `products` finder; profiles gain `products`, `roles`, `cities`, `countries`, `quality`, `profiled_at`; identifier `gmaps`, sources `web` and `maps`; country domain suffixes and shared hosts in `normalizeDomain`; operator routes to create and read jobs | A diesel job for SA over a test pool finishes through the queue with ranked results and reasons, another tenant cannot see it, and two Salla shops stay two companies |
| 18. Claude bridge | `ops/claude-runner/`: a host service that runs `claude -p` with tools, MCP and settings off, a concurrency cap and a timeout; the engine's adapter; a usage limit reschedules the task after the reset | With a fake `claude`, every call carries the locked-down flags, the cap and timeout hold, and a usage limit reschedules; one live call from staging returns JSON |
| 19. Search | Serper web and Places adapter, throttled; `search_queries` cache; search terms from Claude; `discovery.country` and `discovery.blocked_hosts` rule kinds; filter, group, match the registry; first-pass triage | From saved Serper responses a diesel/SA task yields the expected candidates, a re-run makes no Serper calls, and an exhausted key fails the task with a reason |
| 20. Read and extract | Firecrawl reading with a plain-fetch fallback; contacts by pattern; extraction by Claude with every quote checked against the page; CR guard; save through `registry.upsert`; re-read after 90 days only | From saved pages an empty pool ends with the four diesel suppliers saved with checked quotes, a made-up quote is dropped, and a Maps-only company is saved with its phone |
| 21. Review | Approve, reject with a reason, merge, block a domain; `discovery.result.reviewed`; a Discovery view and new-search form in the dashboard | An operator runs a search from the dashboard and reviews it, and the blocked domain is skipped on the next run |

## Migration `0016_discovery_jobs.sql`

**`company_profiles`** (shared, as now) gains:
- `products text[] not null default '{}'`: product names in the company's own words, any language. `sells` keeps its meaning (category codes) and is not touched.
- `roles text[] not null default '{}'`, checked as a subset of `{manufacturer, distributor, wholesaler, retailer, installer, service_provider, transporter, other}`.
- `cities text[] not null default '{}'`.
- `countries text[] not null default '{}'`: ISO 3166-1 alpha-2, upper case.
- `quality text null check (quality in ('full', 'thin'))`.
- `profiled_at timestamptz null`: when web evidence last filled the profile.

`setProfile` and `PUT /v1/companies/:id/profile` accept the new fields, with the same validation as the columns.

**Registry check constraints.** Drop and re-create them:
- `company_identifiers.type` adds `gmaps`.
- `company_sources.source_type` adds `web` and `maps`.

Update the TypeScript unions to match (`IDENTIFIER_TYPES`, `SourceRow`, `UpsertInput.source.type`).

**New tables.** All have `tenant_id uuid not null references tenants` and tenant RLS in the same shape as `0013_campaigns.sql`. Grant `marketing_app` select, insert and update on `discovery_jobs` and `discovery_tasks`, and select, insert and delete on `discovery_results`, because a re-run replaces a task's results.

- `discovery_jobs`:
  - `id uuid pk default gen_random_uuid()`
  - `product text not null` (2–200 characters)
  - `category text null` (free text, at most 200 characters, an optional label from the operator)
  - `side text not null default 'suppliers' check (side in ('suppliers'))`
  - `countries text[] not null` (1–10 ISO alpha-2 codes, unique)
  - `terms text[] not null default '{}'` (search terms; step 19 fills them)
  - `result_limit int not null default 50` (1–200)
  - `status text not null check (status in ('running', 'done', 'failed'))`
  - `counts jsonb not null default '{}'`
  - `created_at`, `finished_at timestamptz null`
- `discovery_tasks`:
  - `id uuid pk`
  - `job_id uuid not null references discovery_jobs`
  - `country text not null`
  - `status text not null check (status in ('queued', 'running', 'done', 'failed'))`
  - `stage text null` (the stage running or last run)
  - `counts jsonb not null default '{}'`
  - `error text null`
  - `attempts int not null default 0`
  - `created_at`, `started_at`, `finished_at` (both `timestamptz null`)
  - `unique (job_id, country)`
- `discovery_results`:
  - `id bigserial pk`
  - `job_id`, `task_id` (references)
  - `company_id uuid not null references companies`
  - `rank int not null`, `score real not null`, `reasons text[] not null`
  - `created_at`
  - `unique (task_id, company_id)`
  - index on `(job_id, rank)`

Review columns are not part of this step; step 21 adds them.

## Registry fixes (`src/spine/registry/identifiers.ts`)

Web data breaks two assumptions.

**`normalizeDomain` returns the registrable domain**, not the bare host:
- Strip subdomains down to the label before the public suffix.
- Keep a small, explicit two-level suffix list: `com.sa`, `net.sa`, `org.sa`, `gov.sa`, `edu.sa`, `med.sa`, `sch.sa`, `co.ae`, `com.ae`, `net.ae`, `org.ae`, `gov.ae`, `ac.ae`, `com.eg`, `com.tr`, `co.uk`, `com.cn`, `co.in`. Everything else counts as one-level.
- Examples:
  - `https://www.Diesel.AlfaFalArabia.com/ar?x=1` → `alfafalarabia.com`
  - `shop.example.com.sa` → `example.com.sa`
  - `x.co.ae` → `x.co.ae`
- Existing identifier rows are not rewritten.

**Shared hosts never identify a company.**
- Add `SHARED_HOSTS` (registrable domains that host many companies): `salla.sa`, `salla.com`, `zid.store`, `zid.sa`, `instagram.com`, `facebook.com`, `linkedin.com`, `x.com`, `twitter.com`, `tiktok.com`, `snapchat.com`, `youtube.com`, `linktr.ee`, `wa.me`, `whatsapp.com`, `t.me`, `business.site`, `wixsite.com`, `blogspot.com`, `wordpress.com`, `google.com`, `myshopify.com`, `manus.space`, `vercel.app`, `netlify.app`, `github.io`, `haraj.com.sa`, `opensooq.com`.
- `isUselessDomain` covers them. A domain identifier on one of them is rejected with reason `shared host`; the caller keeps the URL in the source's `data`.
- This also applies to email domains, the same way free-mail domains are handled.

**`gmaps` is a strong identifier.** Its value is the Google Maps place id or cid as given, trimmed, `[A-Za-z0-9:_-]{1,200}`. Two records with the same `gmaps` value merge.

## The `products` finder (`src/modules/discovery/finder/products.ts`)

`FinderQuery` gains three fields, all optional and ignored by `basic`:
- `products?: string[]`: terms in any language
- `roles?: string[]`
- `cities?: string[]`

**Folding.** Extract the letter folding inside `normalizeName` (lower case, Arabic marks stripped, أ/إ/آ/ٱ → ا, ة → ه, ى/ئ → ي, ؤ → و, non-letters to spaces) into `foldText` in `names.ts`. `normalizeName` then calls it and removes legal-form words as now. `products` uses `foldText`, so words like `شركة` stay meaningful in product text.

**The query.** One SQL query using `pg_trgm`, top of file commented the way `basic.ts` is. It returns companies with a profile where:
- `merged_into` and `on_platform_ref` are null, and the company is not in `excludeCompanyIds`;
- if `country` is given: `companies.country = country` or `country = any(profile.countries)`;
- at least one term matches one of `profile.products`. A term matches when the folded term is contained in the folded product, or their trigram similarity is ≥ 0.4.

**Score** (0..1). The weights are constants at the top of the file, with a comment that they move to rule rows once tuned:

| Signal | Weight |
|---|---|
| Best product similarity (containment counts as 1) | 0.5 |
| Any of `roles` in `profile.roles` | 0.15 |
| Any of `cities` in `profile.cities` (folded, case-insensitive) | 0.15 |
| Quality: `full` 0.1, `thin` 0.05, null 0 | 0.1 |
| Freshness: `profiled_at` within 90 days, falling linearly to 0 at 365 days, null 0 | 0.1 |

**Order and reasons.**
- Sort by score, then `profiled_at` descending, then `created_at` descending, and cap at `limit`.
- Each signal that scored writes one reason: `product: ديزل ~ توريد الديزل`, `role: distributor`, `city: Riyadh`, `profile: full`, `profiled 12 days ago`.

**Registry.** Register it, and export `getFinder(name)` from `finder/index.ts`. `activeFinder()` and the `FINDER` env are unchanged, so `/v1/discovery/search` behaves exactly as before.

## Jobs (`src/modules/discovery/jobs.ts`)

`createJob(tx, { tenantId, product, category?, countries, resultLimit? })`:
- Validate the input.
- Insert the job (`running`) and one `queued` task per country.
- Enqueue `discovery.task` per task, with `singletonKey` set to the task id.
- Emit `discovery.job.created` with `{ jobId, product, countries }`.
- Return `{ job, tasks }`.

**The task worker** (`DISCOVERY_TASK_JOB = 'discovery.task'`, created and registered in `src/jobs/index.ts`, retried the way `SEND_JOB` is):
- Run the task as its tenant (`withTenant`).
- Set the task `running`, `started_at`, and `attempts + 1`.
- Run the stages in order from a `STAGES` array in `jobs.ts`. Each stage is a named async function that receives the job and task and returns counts. The task records `stage` before running each one and merges the counts after. This array is where steps 19 and 20 add `search`, `triage`, `read` and `extract` in front of `rank`. It is a plain array in one file, not a plugin system.
- In this step `STAGES = [rank]`. `rank`:
  - calls `getFinder('products')` with `products = [job.product, ...job.terms]`, `country = task.country` and `limit = job.result_limit`;
  - logs a `finder_runs` row the way `search()` does;
  - replaces the task's `discovery_results` with the candidates, rank 1..n;
  - returns `{ ranked: n }`.
- **On success:** the task is `done`, emitting `discovery.task.finished` with `{ jobId, taskId, country, counts }`.
- **On the final failed attempt:** the task is `failed` with `error` set to the message, emitting `discovery.task.failed`.
- **When no task of the job is `queued` or `running` any more:**
  - the job is `done` if any task is done, and `failed` otherwise;
  - `counts` is the sum of the task counts;
  - `finished_at` is set;
  - `discovery.job.finished` is emitted.

Concurrency is pg-boss's default for the queue. Nothing here calls the network.

## Operator routes (`src/api/routes/operator/discovery.ts`, mounted with the others; internal token as now)

**`POST /internal/discovery/jobs`**
- Body: `{ tenantId, product, category?, countries, resultLimit? }`, with Zod validation.
- Countries are upper-cased ISO alpha-2, 1–10 and unique. Product is 2–200 characters after trimming.
- An unknown tenant returns `404`.
- Success returns `201 { job, tasks }`.

**`GET /internal/discovery/jobs`** (`?tenantId=&status=` with the existing list and page helpers):
- Rows: `id`, `tenantId`, `tenantName`, `product`, `category`, `countries`, `status`, `counts`, `createdAt`, `finishedAt`.

**`GET /internal/discovery/jobs/:id`**
- Returns the job and its tasks: `country`, `status`, `stage`, `counts`, `error`, `attempts` and timings.

**`GET /internal/discovery/jobs/:id/results`** (`?country=`, paged):
- Rows: `rank`, `score`, `reasons`, `country`, and `company` (`id`, `name`, `country`).
- Also the `profile` (`products`, `roles`, `cities`, `quality`, `profiledAt`).
- Also `identifiers`: domain, phone, email and gmaps values.
- Everything the review screen in step 21 needs is in the response, so the dashboard computes nothing (rule 9).

## Tests (`test/discovery-jobs.test.ts`)

Drive the queue the way `test/campaigns.test.ts` does.

1. **Domains.**
   - The three `normalizeDomain` examples above.
   - `https://salla.sa/abc-fuel` and `https://ahmed.business.site` are rejected as `shared host`.
   - Two upserts named "ABC Fuel" and "XYZ Gas", carrying only those Salla URLs as domains, make two companies.
2. **`gmaps` and the new sources.**
   - Two upserts with the same `gmaps` value and sources `maps`, then `web`, make one company with two sources.
3. **`products` finder.** The pool:
   - (a) diesel distributor in Riyadh, `full`, profiled 5 days ago, products `{توريد الديزل}`;
   - (b) diesel retailer in Jeddah, `thin`, products `{Diesel fuel}`;
   - (c) LPG in Riyadh;
   - (d) a diesel company with `on_platform_ref` set;
   - (e) a merged-away diesel company.

   Expected results:
   - `products: ['ديزل', 'diesel']`, `country: 'SA'` → a and b only.
   - Adding `cities: ['Riyadh']` puts a first, and its reasons include its product and city.
   - `الديزل` matches `ديزل`, and `diesel` matches `Diesel fuel`.
   - `limit: 1` returns one.
4. **A job end to end.**
   - `POST /internal/discovery/jobs` with tenant A, product `ديزل` and countries `['SA', 'AE']` → `201` with two queued tasks.
   - Drive the queue: both tasks end `done`. The SA results are a then b; AE has none. The job is `done` with summed counts.
   - Events: `discovery.job.created`, two `discovery.task.finished`, `discovery.job.finished`.
   - `finder_runs` has rows with `finder = 'products'`.
5. **Tenants.** Under tenant B, `discovery_jobs`, `discovery_tasks` and `discovery_results` return no rows for A's job.
6. **Validation.**
   - Country `Saudi` → `400`. Empty product → `400`. Unknown tenant → `404`. No internal token → `401`.
7. **Failure.**
   - Register a finder under the name `products` that throws (restore it afterwards). Driven to its final attempt, the task is `failed` with the error and `discovery.task.failed` is emitted.
   - With every task failed, the job is `failed`.
8. **Unchanged behaviour.** `test/discovery.test.ts` and `test/registry.test.ts` pass untouched, except where a test asserted the old bare-host domain.

## Done when

- CI passes.
- `docs/API.md` has a "Discovery jobs (operator)" section listing the four routes and the five events.
- The amendment in Part A is in, with row 17 marked done.

## Do not

- Call Serper, Firecrawl, the Claude bridge, Wathq or anything else on the network. None of them exist in this step.
- Add a dependency, a `/v1` tenant route for jobs, a search cache table, review columns, rule kinds or dashboard changes. Those belong to steps 18–21.
- Build anything for the Anthropic API, or anything that reads from, writes to or imports the marketplace Admin Panel's data.
- Change `/v1/discovery/search`, the `basic` finder or the `FINDER` default.
- Rewrite existing identifier rows, or loosen any foreign key.
- Create large files. The server disk is about 95% full; test fixtures stay small.

## Report back

PR titled `17 discovery jobs`, opened and not merged. The description includes:
- the CI output;
- anything in the code that made this brief wrong, and what you did instead;
- a short list of what step 19's stages will need from `jobs.ts` that is not there yet.
