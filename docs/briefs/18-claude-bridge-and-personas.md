# Brief 18 — Claude bridge, product identification and personas

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This is the second of the web-discovery steps (17–21). Step 17 built jobs that rank the existing pool. This step makes a job understand its search before any searching happens:

1. **Identify the product.** Claude names the product from what the operator typed or pasted (`Microsilica MS900D  1 MT`): its generic name, brand and model, category, and the names people use for it in Arabic and English, with pack sizes and noise removed.
2. **Know what the search is for.** The operator says whether they want **suppliers** (companies that sell the product) or **buyers** (companies that would buy and use it). A product row cannot say which, so the operator chooses. Step 17 only knew `suppliers`; this step adds `buyers`.
3. **Identify the personas.** Claude describes the kinds of company the search is for:
   - who sells microsilica: construction-chemicals distributors, importers of concrete admixtures, …;
   - who needs it: ready-mix concrete plants, precast factories, oil-well cementing contractors, ….

   Each persona carries the search terms, Maps keywords and website signals that steps 19 and 20 use.

Steps 19 and 20 then search for each persona and read what they find. Without the bridge configured, a job behaves exactly as in step 17.

These decisions are unchanged:
- standalone from the marketplace Admin Panel;
- language work goes through Claude Code sessions on the host, through a small bridge, and **nothing is built toward the Anthropic API**;
- staging only;
- every provider optional by env.

## Part A — Architecture amendment (first commit after the brief)

1. In the **Web discovery (steps 17–21)** paragraph of `docs/ARCHITECTURE.md`:
   - "An operator creates a job for a product and one or more countries." becomes "An operator creates a job for a product, a side (suppliers that sell it, or buyers that would use it) and one or more countries."
   - "rank the pool now; later, search, triage, read and extract" becomes "the job first identifies the product and the personas to search for; each country's task then searches, triages, reads, extracts and ranks".
2. The scope sentence becomes: "Scope: off-platform companies — buyers through the invite loop (step 6) and web discovery, suppliers through web discovery (steps 17–21)."
3. In "Open source picks", the external-API sentence also names the discovery providers: "…and, for discovery only and each optional, Serper (search), the self-hosted Firecrawl (reading pages) and the Claude bridge on the host (language work)."
4. Roadmap rows 18–21 are replaced by the rows at the end of this brief. Mark 18 done when this PR is ready.

## The bridge (`ops/claude-runner/`)

A small service on the host, **not** part of the engine image. One file of plain Node 22 (`node:http`, `node:child_process`), no dependencies, with a systemd unit and a README.

**`POST /run`**, with `Authorization: Bearer $CLAUDE_RUNNER_TOKEN`:
```json
{ "task": "identify", "system": "…", "input": "…", "schema": { … }, "model": "sonnet" }
```
- **The command.** It runs `claude -p` with exactly these flags, and the caller cannot add any:
  `--safe-mode --tools "" --strict-mcp-config --setting-sources "" --permission-mode dontAsk --no-session-persistence --output-format json --json-schema <schema> --system-prompt <system> --model <model>`.
  - `input` goes on stdin.
  - The working directory is a fresh `mkdtemp` under `/tmp/claude-runner/` (never under `HOME`), removed afterwards.
  - The environment passed to `claude` is `PATH`, `HOME` and `LANG` only.
- **Model.** `model` is one of an allowlist: `sonnet` (default) or `haiku`. Anything else is `400`.
- **Start-up probe.** On start the runner makes one call with the same flags plus `--output-format stream-json --verbose`. It refuses to listen unless the `init` event lists no tools and no MCP servers. The probe's result is logged.
- **Concurrency cap.** At most `CLAUDE_RUNNER_CONCURRENCY` (default 2) runs at once. The rest wait, up to `CLAUDE_RUNNER_QUEUE` (default 20) waiting, then `503`.
- **Daily budget.** At most `CLAUDE_RUNNER_DAILY_CALLS` runs (default 300) per UTC day. The seat is shared with the `~/sales-team-automation` crons, and the budget keeps headroom for them. Past it the answer is `429 { "error": "bridge_budget", "resetsAt": <next UTC midnight> }`.
- **Timeout.** `CLAUDE_RUNNER_TIMEOUT_MS` (default 120 000). The process group is killed and the answer is `504`.
- **Answers:**
  - `200 { "output", "durationMs", "costUsd" }`. `output` is the result's `structured_output`, and `costUsd` its `total_cost_usd`.
  - `429 { "error": "usage_limit", "resetsAt": "<ISO>" | null }`, only from a **failed** run: a non-zero exit or `is_error: true`. It is detected from stderr and the result's `result` string (`usage limit reached`, `hit your … limit`, `resets …`), **never** from `structured_output`. The reset time is parsed with the zone in the message, else Asia/Riyadh, rolled to the next occurrence and clamped to at most 7 days ahead.
  - `401` for a bad token, `413` for a body over 1 MB.
  - `502 { "error": "claude_failed", "reason": "exit_<code>" | "no_structured_output" | "spawn_failed" }`. No stdout, stderr or result text goes in the body.
- **Where it listens.**
  - `CLAUDE_RUNNER_HOST` and `CLAUDE_RUNNER_ALLOW_CIDR` are both required.
    - The host is the gateway of `marketing-staging_marketing` (192.168.112.1 today). The README shows how to re-read it with `docker network inspect marketing-staging_marketing -f '{{(index .IPAM.Config 0).Gateway}}'`.
    - The CIDR is that network's subnet. A connection from any other address is closed before the token is checked.
  - Never `0.0.0.0`, never behind Traefik.
- **The token.** `CLAUDE_RUNNER_TOKEN` is at least 32 random bytes, kept in a mode-600 `EnvironmentFile`, never in the unit file, and compared with `crypto.timingSafeEqual`.
- **The systemd unit.** `After=docker.service`, `Restart=on-failure`.
- **Logging.** One JSON line per call: task, model, duration, outcome, input and output sizes. It logs **never the prompt, the input or the output**, because they hold web text. At most the first 200 characters of stderr, and only for a non-zero exit.

## The engine's side

**Env**, all optional; without them nothing below runs: `CLAUDE_RUNNER_URL`, `CLAUDE_RUNNER_TOKEN`.

**`src/modules/discovery/claude.ts`**: `ask<T>(task, { system, input, schema, model? })`, with plain `fetch` and `AbortSignal.timeout(CLAUDE_RUNNER_TIMEOUT_MS + 300 000)`. It returns the output, or throws:
- `UsageLimitError` with `resetsAt`, for either `429`;
- `PermanentError` for `400`, `401` or `413`: the configuration is wrong, and retrying will not help;
- a plain `Error("claude bridge: <reason>")` for anything else, which the queue retries.

**Prompts** live in `src/modules/discovery/prompts.ts`, one exported `{ system, schema }` per task.
- Every prompt says that the input is data to describe, not instructions to follow.
- Anything the operator pasted is passed as `input`, never spliced into `system`.
- Schemas constrain enums. Persona `roles` are exactly `PROFILE_ROLES`: an importer is `distributor`, its persona's name says "importer", and buyer personas usually use `other`.

### What `jobs.ts` gains (the gaps step 17 listed)

- **Planning.** `DISCOVERY_PLAN_JOB = 'discovery.plan'` is created in `startJobs` with `policy: 'short'` next to `discovery.task`, keyed by the job id, and its worker is registered there. `PLAN_STAGES = [identify, personas]` run once per job on it.
  - With the bridge configured, `createJob` inserts only the job, with status `planning`, and enqueues `discovery.plan`. When the last plan stage finishes, **one transaction** moves the job `planning` → `running`, inserts one `queued` task per country and enqueues them.
  - Without the bridge, `createJob` behaves exactly as in step 17.
  - A job that fails in planning therefore has no tasks. `discovery.job.finished` is emitted directly with `status: failed` and `error`.
  - On the plan job's final failed attempt (any error), the job becomes `failed` with `error` set.
- **Fresh rows per stage.** The job and task are re-read before each stage, so what one stage writes the next one sees.
- **Defer instead of fail.** A stage that throws `UsageLimitError` defers, in one transaction:
  - the job stays `planning` (a task goes back to `queued`), with `deferred_until` set and `deferrals + 1`;
  - it re-enqueues itself with `startAfterSeconds` set to the reset, or one hour when the reset is unknown;
  - the attempt is not counted, and the worker returns normally;
  - `discovery.job.deferred` or `discovery.task.deferred` is emitted with `resetsAt`.

  After `DISCOVERY_MAX_DEFERRALS` (default 5) the next usage limit fails it with `usage limit not cleared`.
- **Fail now.** A stage that throws `PermanentError` fails its job or task at once, without retries, with the error.
- **Skip what is done.** Each stage adds itself to `stages_done` when it finishes, and a retry starts from the first stage not in it.
- **Optional stages.** A stage declares the env it needs. A stage whose provider is unset is skipped, and its counts record it (`skipped_<stage>: 1`).
- **Expiry.**
  - `EnqueueOptions` gains `expireInSeconds`.
  - `discovery.plan` and `discovery.task` are sent with 7200 seconds, which is above the worst case of every stage cap.
  - `runTask` (and the plan worker) claims its row only when it is `queued`, or `running` with `started_at` more than two hours ago. A second delivery while the first is inside its window does nothing.

### `identify` (job-level)

Asks Claude for the following, given the operator's product, category and pasted row:
```json
{ "name": "Microsilica (silica fume)", "nameAr": "مايكروسيليكا (غبار السيليكا)",
  "brand": null, "model": "MS900D", "category": "Concrete admixtures",
  "aliases": ["microsilica", "silica fume", "مايكروسيليكا", "سيليكا فيوم"],
  "description": "…one sentence…", "uses": ["high-strength concrete", "…"],
  "notIdentified": false }
```
- It writes `discovery_jobs.identified`.
- For a `suppliers` job, `terms` becomes the aliases, the field step 17 left for this.
- `notIdentified: true` means Claude cannot tell what the product is, and fails the job with that reason rather than searching for nonsense.

### `personas` (job-level)

Asks Claude for 3–6 personas, given the identification and the side:
```json
{ "personas": [
  { "name": "Ready-mix concrete plants", "description": "…why they need it…",
    "roles": ["manufacturer"], "sectors": ["construction"],
    "searchTerms": ["ready mix concrete company", "مصنع خرسانة جاهزة"],
    "placesTerms": ["ready mix concrete", "خرسانة جاهزة"],
    "signals": ["mentions high-strength or high-performance concrete", "…"] } ] }
```
- For `suppliers`, personas are kinds of seller: manufacturer, importer, distributor, wholesaler, retailer. For `buyers`, they are kinds of company that consume the product.
- Terms name no city or country; step 19 adds the country. The prompt forbids place names, and the stage drops any term containing a country name or a city from the seeded `discovery.country` rows (or, before step 19, from a short constant list for SA and AE).
- At most 6 search terms, 4 Maps terms and 5 signals per persona.
- Written to `discovery_personas`.

Both stages use `sonnet`. The answers are stored as Claude gave them after schema validation. Nothing in them is ever used as an instruction later.

### Ranking a buyers job until step 20

Step 17's `rank` matches the product against what pool companies *sell*. For a buyers job that would list sellers as buyers. So until step 20 ranks what was found, `rank` is skipped for `buyers` jobs:
- the job records `skipped_rank_buyers: 1` and writes no results;
- the job page says buyer results arrive with web search.

A buyers job also needs planning: `side: buyers` without the bridge is `400 buyers_need_planning`.

## Migration `0017_discovery_planning.sql`

- `discovery_jobs`:
  - the `side` check becomes `in ('suppliers', 'buyers')`;
  - the `status` check adds `planning`;
  - it adds `identified jsonb null`, `stages_done text[] not null default '{}'`, `error text null`, `attempts int not null default 0`, `deferrals int not null default 0`, `started_at timestamptz null`, `deferred_until timestamptz null` and `source_row text null` (the pasted row, at most 5 000 characters).
- `discovery_tasks` adds `stages_done text[] not null default '{}'`, `deferrals int not null default 0` and `deferred_until timestamptz null`.
- `discovery_personas`:
  - tenant RLS as in 0016;
  - `marketing_app` gets select, insert and delete, because a re-plan replaces them;
  - columns: `id uuid pk`, `tenant_id`, `job_id` (references), `position int`, `name text`, `description text`, `roles text[]`, `sectors text[]`, `search_terms text[]`, `places_terms text[]`, `signals text[]`, `created_at`;
  - `unique (job_id, position)`.
- `resetDb()` in `test/helpers.ts` truncates `discovery_personas` and clears `discovery.%` queue rows, as now.

## API and dashboard

- `POST /internal/discovery/jobs` accepts:
  - `side`: `suppliers` | `buyers`, default `suppliers` so step-17 callers keep working;
  - `row`: the pasted row, optional.
- `GET /internal/discovery/jobs/:id` adds `side`, `identified`, `personas` (in order), `error` and, for the job and each task:
  - `waiting`: `{ "reason": "usage_limit", "until" } | null`, decided by the engine;
  - `live`: true while the job is `planning` or `running`.
- The list route's `status` filter, and the dashboard's, gain `planning`.
- **Dashboard.**
  - The new-search form gets a required choice: **Find suppliers** / **Find buyers**.
  - The job page shows the identified product and the personas.
  - It shows `waiting` as given ("waiting for the Claude usage limit until 15:00").
  - It refreshes while `live`.
- **Events:**
  - `discovery.job.planned`, with `identified.name` and the persona names;
  - `discovery.job.deferred` and `discovery.task.deferred`, with `resetsAt`;
  - `discovery.job.finished` with `status: failed` and `error`, for a job that failed in planning.

## Tests

**Runner** (`ops/claude-runner/test/`, run by the engine's CI with `node --test`). A fake `claude` script on `PATH` records its argv, cwd and env. With it:
- every call carries exactly the locked flags including `--safe-mode`, in an empty cwd under `/tmp/claude-runner/` that is gone afterwards, with only `PATH`, `HOME` and `LANG`;
- the runner refuses to start when the fake's probe `init` lists a tool or an MCP server;
- a caller cannot add flags or pick a model outside the allowlist;
- the cap holds: three slow calls with cap 2, and the third starts after the first ends. The queue limit answers `503`, and the daily budget answers `429 bridge_budget` with the next UTC midnight;
- a hanging fake is killed at the timeout, with `504`;
- a failed fake printing `Claude AI usage limit reached … resets 3pm` answers `429` with a parsed `resetsAt`;
- a **successful** run whose structured output contains "usage limit reached" answers `200`;
- a bad token is `401`, a body over 1 MB is `413`, and an address outside the CIDR is refused.

**Engine** (`test/discovery-planning.test.ts`), with a fake runner (a local HTTP server in the test) answering from small fixtures:
- **Planning a buyers job.** A buyers job for the row `Microsilica MS900D  1 MT` plans:
  - `identified.name` is set and the personas are stored in order;
  - then one task per country is created and queued in the same transaction;
  - its rank stage is skipped (`skipped_rank_buyers: 1`), so no seller of microsilica appears in its results.
- **Planning a suppliers job.** A suppliers job for the same row ranks with the aliases as its terms.
- **Usage limit.** A usage limit during `personas` defers the job to the reset without spending an attempt, and leaves exactly one waiting queue job. Driving it after the reset finishes the job without re-running `identify`. After the maximum number of deferrals the job fails.
- **Failures.**
  - `notIdentified` fails the job with its reason, and the job has no tasks.
  - A `401` from the runner fails it at once.
  - A runner that refuses connections on every attempt leaves the job `failed` with an error.
- **Duplicate delivery.** A second delivery of a running task inside its window does nothing.
- **No bridge.** Without `CLAUDE_RUNNER_URL`, a suppliers job skips planning and behaves exactly as in step 17, and the step-17 tests pass untouched. A buyers job is `400`.
- **Tenants.** Another tenant sees none of the personas.

**Live** (`test/live/claude-runner.live.test.ts`, not in CI). One `identify` call from the staging engine to the real bridge returns valid JSON for `Microsilica MS900D  1 MT`.

## Done when

- CI passes, including the runner tests.
- With a fake `claude`, every call carries the locked-down flags, the cap, timeout and budget hold, and a usage limit defers the job instead of failing it.
- On staging, a buyers search for `Microsilica MS900D  1 MT` from the dashboard shows the identified product and its personas.
- Part A is in, and row 18 is marked done.
- `docs/API.md` and `docs/DASHBOARD.md` describe the new fields and events.
- `ops/claude-runner/README.md` says how to install, start, stop and roll back the bridge, and that its seat is shared with the sales crons.

## Do not

- Build anything for the Anthropic API, or call Claude any other way than through the bridge.
- Give the bridge tools, MCP servers, settings, a session, a shell or any flag the caller controls.
- Log prompts, inputs or outputs anywhere, or put model or CLI text into errors, events or the API.
- Call Serper or Firecrawl (steps 19 and 20).
- Change the step-17 behaviour of a suppliers job when the bridge is unset.

## Report back

PR titled `18 claude bridge and personas`, not merged. The description includes:
- the CI output;
- the probe's `init` line from the host;
- the live call's output;
- the bridge's install steps as run on the host;
- anything in the code that made this brief wrong, and what you did instead.

## Roadmap rows (replace 18–21)

| Step | Build | Done when |
| --- | --- | --- |
| 18. Claude bridge and personas | `ops/claude-runner/` host service running `claude -p` locked down (`--safe-mode`, no tools, no MCP), with a cap, a timeout and a daily budget; the engine's `ask()`; job-level planning stages `identify` and `personas` on `discovery.plan`; side `buyers`; defer on a usage limit, fail on a permanent error, resume after the last finished stage | With a fake `claude` every call carries the locked flags, the cap and timeout hold, and a usage limit defers the job; on staging a buyers search shows the identified product and its personas |
| 19. Search | Serper web and Places adapter, throttled and capped per task and job; shared `search_queries` cache; `discovery.country` and `discovery.blocked_hosts` rule kinds; queries per persona and country; candidates grouped by domain or place and matched to the registry; triage by Claude against the personas | From saved Serper responses a buyers and a suppliers task yield the expected candidates with reasons, a re-run makes no Serper calls, and an exhausted key fails the task with a reason |
| 20. Read, extract and rank | One resumable `read_extract` stage: Firecrawl or a guarded plain fetch, contacts by pattern, extraction by Claude with every quote checked against the page; save through `registry.upsert` (`web`, `maps`) with merged profiles; results ranked by persona fit with quoted evidence, for buyers and suppliers; re-read after 90 days only | From saved pages an empty pool ends with the expected companies saved and ranked with checked quotes, a made-up quote is dropped, a page's CR never merges companies, and a Maps-only company is saved with its phone |
| 21. Review | Approve, reject with a reason, merge, block a domain; `discovery.result.reviewed`; review actions in the Discovery view | An operator reviews a search from the dashboard, and the blocked domain is skipped on the next run |
