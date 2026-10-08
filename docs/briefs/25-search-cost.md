# Brief 25 — What the searches cost

Asked for on 2026-10-08: "show more logging on the dashboard. Let's start with the cost of the searches done: the cost of each search done, and all searches as cumulative. In the overview show Serper cost: average for all searches, per search, and all the good statistics."

Serper is the only search provider that costs money. It bills in credits: every `/search` and `/places` call answers with a `credits` field (1 for ten results, 2 for more), and a credit's price depends on the pack bought (USD 1.00 per 1,000 on the smallest pack, down to 0.30 on the largest). Until now the engine counted `serper_calls` per task and nothing else: no credits, no money, and a task that failed half-way lost even that count.

In the dashboard's language a *search* is a discovery job (what the operator starts from "New search"), and a *query* is one question to Serper or to the cache. Both levels are needed: the operator asks "what did this search cost" and "what do searches cost on average"; Serper bills per query.

## What changes

**1. Every query is an event.** The `search` stage appends `discovery.task.queried` to `events` after each query, as it happens, so a task that fails on its twelfth query still has its first eleven on record. `subjectType` is `discovery_job`, `subjectId` the job's id. Payload: `jobId`, `taskId`, `country`, `personaId`, `provider` (`serper`), `kind` (`web` or `places`), `q`, `gl`, `hl`, `page`, `cached`, `credits` (what Serper said, 0 from the cache, 1 when Serper says nothing), `hits`. The event log is the only source of what was spent; task counts gain `serper_credits` for the counts display and nothing reads them for money.

**2. The adapter reports credits.** `searchWeb` and `searchPlaces` return `{ hits, credits }`; the cache returns `credits: 0` for an answer it had. Nothing else from the response is kept.

**3. Money is worked out at read time.** `SERPER_USD_PER_CREDIT` (default `0.001`) prices a credit. Every figure is credits from the events times this price, so a corrected price corrects every figure at once, past and future. No migration.

**4. The operator API says what was spent.**
- `GET /internal/overview` gains `serper`: `usdPerCredit`; `window` and `allTime` totals (`searches`, `queries`, `serperCalls`, `cacheHits`, `credits`, `usd`, `cacheRate`, and averages `perSearch`, `perQuery`, `perCall`); in the window, `byKind`, `byCountry`, `byTenant`, `topSearches` (the five costliest jobs) and `series` (credits and queries per hour for a window up to two days, per day beyond, empty buckets included).
- `GET /internal/discovery/jobs` rows and `GET /internal/discovery/jobs/:id` (the job and each task) carry `spend`: `queries`, `serperCalls`, `cacheHits`, `credits`, `usd`.
- `GET /internal/discovery/queries?jobId=&tenantId=&country=&kind=&cached=` lists every query, newest first, each with its job's product, persona, whether the cache answered, credits and `usd`. With `jobId` it lists the job's whole history; otherwise the window applies (default 7d).

**5. The dashboard shows it.** The overview gets a "serper cost" card: the window's and all-time totals and averages, a line of credits and queries over the window, and the breakdown tables. The Discovery list gets a cost column; a search's page shows its cost, each task's cost, and every query it made with what it cost. The dashboard renders what the API returns and works out nothing.

## Not in this brief

- Serper's live balance (`GET /account`): a call to a provider from a route polled every ten seconds. A later brief can cache it.
- The cost of Claude calls or Firecrawl reads.
- An index on `events` for this type: the table is small on both stacks; add a partial index when it is not.

## Done when

1. From saved Serper responses, a suppliers task records one `discovery.task.queried` event per query with the credits each response said, the job's and task's `spend` add up to them, and the queries route lists them priced at `SERPER_USD_PER_CREDIT`.
2. A repeated search records its queries as cached, at zero credits.
3. A task that fails on its third query has its first two on record and in the job's spend.
4. The overview's `serper` section adds up across two jobs: window and all-time totals, averages, by kind, by country, by tenant, top searches, and a series whose points sum to the total.
5. The dashboard renders the card, the column and the queries list from fixtures.
