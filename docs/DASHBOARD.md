# Building the operator dashboard

For whoever builds the admin screen in the marketplace. The engine serves the
data; it owns no HTML and never will.

**The one rule: the admin renders, the engine decides.** If a number needs
computing, a state needs interpreting, or a decision needs making, it happens
in the engine and arrives as a field. A dashboard that recomputes something the
engine already knows will eventually disagree with it, and then nobody knows
which is right.

## Authentication

Every endpoint here is under `/internal/` and takes `X-Internal-Token: <INTERNAL_TOKEN>`
— the marketplace's own key, not a tenant JWT. A tenant JWT on these routes is
a 401. **The dashboard must call these from its own server, never from a
browser**: the internal token opens every tenant's data.

## Conventions

- Lists take `limit` (1..500, default 100) and `cursor` (the last row's `id`),
  return `{ items, nextCursor }`, newest first. `nextCursor` is `null` on the
  last page. Never an offset: rows arrive while you page, and an offset would
  skip and repeat them.
- Windows are `since`/`until` ISO timestamps, or `window=1h|24h|7d|30d` as
  shorthand for `since = now - window`.
- Cross-tenant rows carry `tenantId` and `tenantName`.
- Secrets never appear. Channel configs come back redacted exactly as the
  tenant's own `GET` returns them, and webhook endpoints never include their
  signing secret.

## The views

### 1. Overview

**`GET /internal/overview?window=24h`**, polled every 10 seconds.

One call fills the whole screen: health, per-queue job counts, message counts
by status, why messages were blocked, a row per tenant, webhook pending and
failed, open reservations and how many expire within fifteen minutes, and
discovery search counts.

Nothing is cached, so what it says is true at `asOf`. Render `blockedReasons`
prominently — `no_consent`, `suppressed`, `rule:<name>` — because that is where
a misconfigured tenant shows up first.

### 2. Live feed

**`GET /internal/stream`**, Server-Sent Events. Optional `tenantId` and `type`
(a trailing `*` is a prefix: `message.*`).

```
id: 48213
event: message.sent
data: {"id":"48213","type":"message.sent","tenantId":"…","subjectType":"message", …}
```

- Use `EventSource`, or any SSE client, from your server.
- **Send `Last-Event-ID` on reconnect.** The engine replays what you missed from
  the event table (up to 1000) and then continues live, so a dropped connection
  loses nothing.
- A comment line arrives every 15 seconds so idle proxies do not close it.
- The payload is deliberately small. For an event's full payload, call
  **`GET /internal/events/:id`**.
- At most 20 concurrent streams; the 21st gets a 503. One stream per dashboard
  process, fanned out to browsers by you — not one per open tab.

### 3. Queue

**`GET /internal/jobs?name&state&limit&cursor`** and
**`GET /internal/jobs/:id`**. On demand, plus the overview's queue section for
the counts.

States are pg-boss's: `created`, `retry`, `active`, `completed`, `cancelled`,
`failed`. A failed job carries its error in `output`. When a job's data names a
message or a delivery, the row carries that owner's `tenantId` and `tenantName`.

**`POST /internal/jobs/:id/retry`** puts a `failed` job back. Any other state is
a 409 — a job that is still going does not need help, and a completed one would
run twice.

**`GET /internal/schedules`** lists the crons with their cron strings, when each
last completed and how it went.

### 4. Per-tenant

**`GET /internal/tenants`** for the list with 24-hour counts, and
**`GET /internal/tenants/:id`** for one: its channels (redacted), template
names, rule counts by kind, webhook endpoints, and counts over 24h, 7d and 30d.

Drill down with the feeds, all filtered by `tenantId`:
**`/internal/messages`**, **`/internal/events`**, **`/internal/redemptions`**,
**`/internal/invites`**.

### 5. Message detail

**`GET /internal/messages?…`** already gives each row a `timeline` — its own
events in order — so the list answers "what happened to this?" without a click.

**`GET /internal/messages/:id`** gives the rest: every event, the delivery
reports with the provider's raw body, the fallback children, and the parent if
this message is itself a fallback. This is the view for "why did this not
arrive?", and the raw body is usually the answer.

### 6. Deliveries

**`GET /internal/webhook-deliveries?status=failed`** across every tenant, with
the event type and the endpoint URL. Attempts run at 1m, 5m, 30m, 2h and 12h
before a delivery is marked `failed`.

**`POST /internal/webhook-deliveries/:id/replay`** queues it again, for any
tenant including the platform endpoint.

### 7. Campaigns

**`GET /internal/campaigns?tenantId&status`**, polled every 5 seconds, and
**`GET /internal/campaigns/:id`** for one campaign with every run.

The list shows each campaign's status, `nextRunAt`, and the latest run's
counts. The detail shows the run history with a progress bar — the run's
`queued + blocked + skipped` over its `audienceSize`, both from the API — and,
for the selected run, **`GET /internal/campaigns/:id/runs/:runId/recipients?state=`**:
who got it, who did not, and why. The overview's `campaigns` section is the
card on the front page.

### 8. Promocodes

**`GET /internal/promocodes?tenantId&status&code`** (`code` is a
case-insensitive prefix) and **`GET /internal/promocodes/:id`** for one code.

Each row has every field of the code — discount, rules, budget, funders,
validity, status — plus `usage` and `availability`, both computed by the
engine. `usage.uses` and `usage.spend` are the reserved and settled
redemptions, the same numbers checkout's budget check reads, so the screen and
checkout cannot disagree. `usage` also has the count and amount per redemption
status, distinct buyers, what is left of `maxUses` and `maxSpend` (`null` when
unset) and when the code was last redeemed. `availability` is one word:
`paused`, `ended`, `scheduled`, `expired`, `exhausted` or `live`. `live` does
not mean every cart validates: per-buyer limits, the minimum subtotal and rules
still apply.

A code's redemptions come from **`GET /internal/redemptions?promocodeId=`**;
pass `since` as the code's `createdAt`, or the feed's 30-day default hides older
ones. Each redemption row carries `promocodeId` and `buyerCompanyRef`, the
client's own id for the buying company (null when it did not send one).

### 9. Discovery

**`GET /internal/discovery/jobs?tenantId&status`** lists searches;
**`GET /internal/discovery/jobs/:id`** is one search with its tasks, and
**`GET /internal/discovery/jobs/:id/results?country=`** its ranked companies,
each with the engine's reasons, profile and identifiers.

**New search** posts to **`POST /internal/discovery/jobs`**. A row pasted from
the portal's product table goes first to **`POST /internal/discovery/read-row`**,
which says which cells it reads as the product and category; the form shows
every cell with those two marked, and the operator can change either before
searching. Countries are typed as codes; the engine validates them and every
other field, and the form shows its refusal verbatim.

The operator chooses what the search is for: **Find suppliers** (companies
that sell the product) or **Find buyers** (companies that would buy and use
it). With the Claude bridge configured a search first plans: the job page shows
the product as Claude identified it and the personas it will search for. When
a Claude usage limit is hit the job or task says `waiting` with the time it
resumes, as the engine reports it; the page asks again while the engine says
the job is `live`.

**Search** first posts to **`POST /internal/discovery/identify`**
("understanding your product…"). When the engine returns no `didYouMean`, the
search is created at once with its `identified`; when it does, the form shows
"did you mean" (the best reading, the other readings, "search as typed") and one
click creates the search, nothing having been searched before. If identifying
fails, the product is searched as typed.

**RFQ searches.** The new-search form has "RFQ (several products)": an RFQ
reference and one product per line, posted to
**`POST /internal/discovery/rfq-searches`**. The Discovery view links to the
**RFQ searches** list (**`GET /internal/discovery/rfq-searches`**); an RFQ
search's page (**`GET /internal/discovery/rfq-searches/:id`**) shows the RFQ,
then each product in order with its status, counts and ranked companies (each
line's results come from its job's results route). A product search that is one
line of an RFQ links back to it.

**Countries.** The Discovery view links to **Countries**
(**`GET /internal/discovery/countries`**): every country a search has a row
for, with its languages, cities and who made the row (seeded, Claude or an
operator). **Edit** opens the row's settings as JSON; **Save** posts them to
**`POST /internal/discovery/countries/:code`**, and the engine's refusal, if
any, is shown as it came.

**Download CSV** on a search's page links to
**`GET /internal/discovery/jobs/:id/results.csv?country`**: the engine writes
the file, for the country selected or all of them.

**`GET /internal/discovery/jobs/:id/candidates?country&status`** is what the
searches found, kept first, with each candidate's persona, fit and triage
reason; the job page lists the kept ones and shows the dropped ones on request.

Until reading arrives (step 20), a suppliers search ranks only the companies
already in the pool and a buyers search ranks nothing; the view says so.

## Charts

**`GET /internal/metrics?series=&bucket=&window=&tenantId=&groupBy=`**

`series` is `messages`, `events`, `redemptions` or `searches`; `bucket` is
`hour` or `day`; `groupBy` is `status` or `channel` for messages, `status` for
redemptions, `type` for events. Returns `{ bucket, series: [{ key, points: [[ts, count]] }] }`.

Enough for a chart and nothing more. It is not a metrics system, and if you
need percentiles or retention, read the event log into something that is.

## Refresh model

| View | How |
| --- | --- |
| Overview | poll every 10s |
| Live feed | SSE, always connected |
| Queue | on demand, plus a poll while someone is watching a retry |
| Per-tenant | on demand |
| Message detail | on demand |
| Deliveries | on demand |
| Promocodes | on demand |
| Discovery | list every 10s; a running search every 3s until it finishes |

## What is not here

No write endpoints beyond retry and replay, and the discovery operator
actions: creating a search (step 17) and reviewing results (step 21). No
per-tenant dashboard routes — tenants already have their own scoped lists
under `/v1`. No HTML. If the
dashboard needs something the engine does not expose, add a read endpoint here
rather than reaching into the database: direct database access is how two
sources of truth start.
