# marketing-engine

A standalone, multi-tenant marketing engine: messaging, company discovery and
promocodes. One Node service, one Postgres, one HTTP API. No screens.

See `docs/ARCHITECTURE.md` for the design and `docs/briefs/` for the steps.

## Run it locally

You need Node 22 and a Postgres you can write to. Any Postgres will do; the
bundled compose file brings one up on `127.0.0.1:55432` with the `marketing`
and `marketing_test` databases already created:

```bash
docker compose up -d
```

Then, the four commands:

```bash
npm install                 # install dependencies
cp .env.example .env        # then edit DATABASE_URL and JWT_SECRET
npm run migrate             # apply src/db/migrations in order
npm run dev                 # start the service on $PORT (default 3000)
```

`npm test` runs the suite against `DATABASE_URL_TEST`. It migrates and truncates
that database, so point it at a throwaway one.

`npm run test:live` sends one real SMS through Taqnyat. It is skipped unless
`TAQNYAT_BEARER`, `TAQNYAT_SENDER` and `LIVE_SMS_TO` are all set, and it is
never part of `npm test` or CI.

`npm run build` compiles to `dist/`; `npm start` runs the build.

## API

| Route | Auth | What |
| --- | --- | --- |
| `GET /health` | none | `{ ok, db }` |
| `POST /v1/events` | Bearer JWT | append one event |
| `GET /v1/events?type=&since=&limit=` | Bearer JWT | read this tenant's events |
| `POST /v1/consent` | Bearer JWT | record a `granted` or `revoked` consent |
| `POST /v1/suppression` | Bearer JWT | block an address for this tenant |
| `GET /v1/can-send?channel=&address=&purpose=&at=` | Bearer JWT | ask whether a message may go out |
| `GET /v1/rules`, `POST /v1/rules`, `DELETE /v1/rules/:id` | Bearer JWT | read all rules; create and delete this tenant's own |
| `PUT /v1/channels/:channel` | Bearer JWT | store this tenant's provider credentials for a channel |
| `GET /v1/channels/:channel` | Bearer JWT | the channel's provider and sender, never the credentials |
| `PUT /v1/templates/:name` | Bearer JWT | create or replace a Liquid template |
| `POST /v1/messages` | Bearer JWT | send intent: 202 when queued, 200 when `can_send` refused |
| `GET /v1/messages/:id` | Bearer JWT | one message and its status |
| `POST /webhooks/:provider/:token` | token in the URL | provider callbacks |
| `GET /webhooks/whatsapp-meta/:token` | token in the URL | Meta's subscription handshake |
| `POST`/`GET /unsubscribe/:token` | signed token | one-click opt-out from an email |
| `POST /v1/companies` | Bearer JWT | add or match a company in the prospect pool |
| `GET /v1/companies/:id` | Bearer JWT | a company, its identifiers, your view and your sources |
| `GET /v1/companies?identifier=cr:101…` | Bearer JWT | the same, found by identifier |
| `PUT /v1/companies/:id/view` | Bearer JWT | your relationship, tags and notes for it |
| `POST /v1/companies/import` | Bearer JWT | bulk CSV import |
| `POST /v1/discovery/search` | Bearer JWT | ranked off-platform buyers from the pool |
| `PUT /v1/companies/:id/profile` | Bearer JWT | what a company buys, sells, its sector and city |
| `POST /v1/companies/:id/invite` | Bearer JWT | invite a company to the marketplace |
| `GET /v1/invites/:id` | Bearer JWT | one of your invites |
| `GET /i/:token` | public | the invite link; redirects to signup |
| `POST /internal/invites/accept` | `X-Internal-Token` | the marketplace reporting a signup |
| `POST`/`GET /v1/promocodes` | Bearer JWT | create a code; list with usage |
| `GET`/`PATCH /v1/promocodes/:id` | Bearer JWT | one code; pause or end it |
| `POST /v1/promocodes/validate` | Bearer JWT | what is this code worth on this cart? |
| `GET /v1/promocodes/reconcile` | Bearer JWT | does spend equal settlement? |
| `POST /v1/redemptions` | Bearer JWT | reserve the discount for an order |
| `POST /v1/redemptions/:id/settle` | Bearer JWT | the order completed |
| `POST /v1/redemptions/:id/release` | Bearer JWT | the order went away |
| `GET /v1/redemptions/:id`, `?orderRef=` | Bearer JWT | one redemption |
| `POST /v1/contacts`, `GET /v1/contacts`, `GET`/`PATCH /v1/contacts/:id` | Bearer JWT | stored contacts |
| `POST /v1/contacts/import` | Bearer JWT | CSV of contacts, with consent where a row carries the evidence |
| `POST`/`GET /v1/audiences`, `GET`/`PATCH`/`DELETE /v1/audiences/:id` | Bearer JWT | static and search audiences |
| `POST /v1/audiences/:id/members`, `DELETE …/members/:contactId` | Bearer JWT | a static audience's members |
| `POST /v1/audiences/:id/preview` | Bearer JWT | who would actually get a send, and why not |
| `POST`/`GET /v1/campaigns`, `GET`/`PATCH /v1/campaigns/:id` | Bearer JWT | campaigns |
| `POST /v1/campaigns/:id/schedule`, `/pause`, `/resume`, `/cancel` | Bearer JWT | move a campaign through its life |
| `GET /v1/campaigns/:id/runs`, `…/runs/:runId/recipients` | Bearer JWT | runs, and who got it |

Auth is a Bearer JWT signed HS256 with `JWT_SECRET` and carrying a
`tenant_id` claim. Anything else is a 401.

Writes accept an `Idempotency-Key` header. A repeat of the same key from the
same tenant replays the stored response and does not run the handler again.

```bash
curl -s localhost:3000/v1/events \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: abc-123' \
  -d '{"type":"thing.happened","subjectType":"thing","subjectId":"1","payload":{}}'
```

## Can this message go out?

`can_send()` is the only place that answers, and it answers in a fixed order.
**Suppression** first: a block on the address, either this tenant's or a
platform-wide one, ends it immediately — an opt-out beats everything, including
a transactional message. **Consent** next, and only for `marketing`: the latest
consent row for that tenant, channel, address and purpose must say `granted`,
so a revoke recorded after a grant wins. Transactional messages skip this step.
**Rules** last: every enabled `sending_window` rule runs against the request in
scope order — platform, then the contact's region, then the tenant's own — and
the first rule that matches denies. That ordering is what stops a tenant from
writing a rule that lifts a platform or regional restriction; a tenant can only
add limits. The answer is `{ allowed: true }` or `{ allowed: false, reason }`
where `reason` is `suppressed`, `no_consent` or `rule`, naming the rule that
decided. `GET /v1/can-send` is a dry run and sends nothing.

Addresses are normalised before anything is stored or compared: phones to E.164,
emails lower-cased. A contact's region comes from its phone country, which is
what picks the time zone a sending window is measured in; email and telegram
have no region, so only platform and tenant rules apply to them. Pass
`defaultCountry` (ISO 3166-1 alpha-2) alongside a national number like
`0501234567` to have it parsed.

## Sending a message

`POST /v1/messages` takes an intent, not a channel command: who, which template,
which purpose. A contact carries one address per channel, and a phone serves
both SMS and WhatsApp:

```json
{
  "contact": { "phone": "+9665...", "email": "a@b.co", "telegram": "123456789" },
  "purpose": "marketing",
  "template": "order_update",
  "variables": { "order": "A-1043" },
  "defaultCountry": "SA"
}
```

Name a `channel` and that is the channel. Leave it out and the engine picks:
it asks suppression and consent of every channel the contact has both an
address and a configured provider for, lets a `channel_selection` rule order
what is left, and applies the sending window to the one it picks. Channels
after the winner become its fallback order. A tenant's own selection rule beats
the platform default, because an order is a preference — whatever comes back,
every channel in it still has to pass `can_send`.

Nothing usable is not an error: it is a `messages` row with
`status: 'blocked'`, `blocked_reason: 'no_channel'` and a `message.blocked`
event naming each channel's reason, returned with 200. A `queued` message comes
back 202; the pg-boss worker sends it with the tenant's own credentials and
writes `sent`, and provider callbacks move it to `delivered`, `read` or
`failed`. When a send fails for good and a fallback remains, the worker re-runs
the same intent on the next channel as a child message and emits
`message.fallback`. Every transition appends to `events`.

Marketing messages on SMS, WhatsApp and Telegram need `unsubscribeText` on the
channel config; it is appended to the body on its own line, and a send without
it is a 422. Email carries its opt-out in the `List-Unsubscribe` header instead.
Templates are Liquid, rendered with `strictVariables`, so a missing variable is a
400 naming it rather than an empty string sent to a real person.

### The four providers

| Provider | Channel | `config` keys |
| --- | --- | --- |
| `taqnyat` | `sms` | `token`, `baseUrl?` |
| `whatsapp-meta` | `whatsapp` | `accessToken`, `phoneNumberId`, `appSecret`, `apiVersion?` |
| `email-smtp` | `email` | `host`, `port`, `secure`, `user`, `pass`, `fromName?` |
| `telegram` | `telegram` | `botToken` |
| `fake` | all four | `token` (`"bad"` fails validation) |

An email template needs a `subject`; a WhatsApp template needs a `providerRef`
naming the Meta-approved template and the order its positional parameters are
filled, because Meta does not accept free text for business-initiated messages:

```json
{ "channel": "whatsapp", "body": "Hi {{ name }}",
  "providerRef": { "name": "greet", "language": "ar", "params": ["name"] } }
```

A template missing the piece its channel needs is `template_unfit`.

Provider credentials are AES-256-GCM encrypted before they touch the database,
with a key the database never sees. Generate one with:

```bash
openssl rand -hex 32     # this is CREDENTIALS_KEY
```

`GET /v1/channels/:channel` returns the provider, sender and `configured: true`
and never the credentials themselves.

## Provider webhooks

Callbacks arrive at one URL shape, which you register with each provider:

```
POST https://<PUBLIC_BASE_URL>/webhooks/<provider>/<WEBHOOK_TOKEN>
```

There is no JWT — a provider has none — so the URL itself is the secret. A wrong
token gets the same 404 as an unknown path. Set `WEBHOOK_TOKEN` to something
long and random and treat the whole URL as a credential. A body an adapter
cannot make sense of is logged and answered 202: replying 4xx makes a provider
retry the same body forever.

- **Taqnyat** — set the delivery-report URL in the dashboard. The callback shape
  is not in their OpenAPI spec, so the parser is permissive and carries a TODO.
- **WhatsApp (Meta)** — register the same URL as the webhook callback with
  `WEBHOOK_TOKEN` as the verify token. Meta GETs it once and expects the
  challenge echoed, which `GET /webhooks/whatsapp-meta/:token` does. Meta signs
  every payload, so the tenant is resolved from `phone_number_id` and the body
  is checked against that tenant's `appSecret`. A bad signature is the one case
  a provider gets a 401 from us: it is not a malformed body, it is someone who
  should not be posting here.
- **Telegram** — register with the secret header:
  ```bash
  curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
    -d "url=https://<PUBLIC_BASE_URL>/webhooks/telegram/<WEBHOOK_TOKEN>" \
    -d "secret_token=<WEBHOOK_TOKEN>"
  ```
  Telegram has no delivery reports; the callback carries inbound replies only.
- **SMTP** — no callbacks at all. A sent email stays `sent`.

Inbound replies become `message.replied` events with the text. Acting on a STOP
reply is a rule for a later step; nothing is automatic yet.

## Unsubscribe

Marketing email carries `List-Unsubscribe` and `List-Unsubscribe-Post`, which is
what Gmail and Yahoo require on bulk mail and the difference between an opt-out
and a spam complaint. The link is
`<PUBLIC_BASE_URL>/unsubscribe/<token>`, where the token is an HMAC over the
tenant, channel and address signed with `WEBHOOK_TOKEN` — so there is no table
behind it and a tampered link is a 404. Following it writes both a suppression
and a revoked consent, so `can_send` says `suppressed` from then on.

## The company registry

A platform-owned pool of companies that are **not** on the marketplace:
prospects arriving through an import, an RFQ counterparty, an API call or a
registrar lookup. One real company is one row whoever contributed it, so
`companies` and `company_identifiers` are shared across tenants — the only
tables that are. What a tenant says *about* a company (relationship, tags,
notes) and which sources it contributed stay private to that tenant.

`registry.upsert` is the only way in, and identity is decided by identifier,
not by name:

| type | stored as | strength |
| --- | --- | --- |
| `cr` | digits only | strong |
| `vat` | digits only | strong |
| `domain` | bare host, no scheme, no `www.` | strong |
| `phone` | E.164 | weak |
| `email` | lower-cased; also yields its domain | weak |

**Strong** identifiers belong to one company: one match is that company, and
two records carrying two different companies' strong identifiers mean those
were always the same company. **Weak** ones link but never merge, because a
phone number or a shared mailbox moves between businesses; one already pointing
elsewhere is left where it is and noted on the source row. Free-mail domains
(`gmail.com` and friends) and `PLATFORM_DOMAIN` are dropped: they identify
nobody.

Only when no strong identifier matches does the name get a say, and then only
to **link**, never to merge, at a similarity of 0.90 or better on the
normalised name. Normalisation folds case, Arabic orthography (tashkeel,
`أإآ`→`ا`, `ة`→`ه`, `ى`→`ي`) and legal-form words in both languages, so
`شركة الفلاح للتجارة` and `الفلاح للتجاره` are one name, as are
`Al-Falah Trading Co. Ltd` and `AL FALAH TRADING`. Below 0.90, genuinely
different Saudi trading companies collide; looser matching is a search-ranking
question for discovery, not a claim that two records are the same company.

### Merges are reversible

A merge keeps every row. The oldest company survives; each loser keeps its row
with `merged_into` pointing at the survivor, and its identifiers, sources,
message stamps and per-tenant views are moved across. A tenant that knew both
ends up with one view, tags unioned and notes kept end to end, rather than one
silently winning. `GET /v1/companies/:id` on a merged-away id returns the
survivor. To undo one by hand: clear `merged_into`, and the source rows record
what each contributor said and when. A merge emits `company.merged` naming the
survivor and the losers.

### CSV import

`POST /v1/companies/import` with `Content-Type: text/csv`, up to 5,000 rows,
header exactly:

```
name,country,cr,vat,domain,phone,email,relationship,tags
```

`tags` are `;`-separated. Each row runs through the same `upsert`, with
`source.ref` set to `<ref>:<line>` so any row can be traced back. The response
is `{ rows, created, linked, merged, rejected }`, where `rejected` names the
line number and why. A row that offered identifiers and had none of them
survive normalisation is rejected rather than stored, since nothing could ever
match it.

### Enabling Wathq

Company lookup is off unless `WATHQ_API_KEY` is set (`WATHQ_BASE_URL` overrides
the host). With it set, `POST /v1/companies` with `"enrich": true` and a `cr`
identifier asks the registrar first, takes its name over the caller's, and
writes a second `lookup` source row holding the whole response. Enrichment
never fails a write: no key, no CR, or a registrar that does not know simply
stores what it was given.

**The Wathq response mapping is unverified.** Wathq keeps its response schema
behind the developer portal and answers 401 to an unauthenticated probe, so the
field names in `wathq.ts` are best guesses and the adapter keeps the entire
payload in `raw` regardless. Before relying on it, make one real call, look at
the body, and fix `factsFrom`; the `raw` on any `lookup` source row already
written is enough to do that retrospectively.

## Discovery

A supplier asks which off-platform corporate buyers it should talk to, and gets
a ranked list out of the prospect pool. Companies already on the marketplace
(`on_platform_ref` set) and companies merged away are never returned.

**The matching algorithm is a placeholder, deliberately.** The `basic` finder is
an AND of exact filters on profile fields plus trigram matching on the name, so
every row it returns matched everything that was asked and scores 1.0. It is
not a ranking. What is real is the seam around it: the endpoint, the invite
loop, and a `finder_runs` row for every search recording the query, the result
count and how long it took — which is the evidence whoever picks the real
algorithm should choose it on.

### Adding a finder

1. Write one file implementing `Finder` in `src/modules/discovery/finder/`.
2. Register it in `finder/index.ts` with `registerFinder`.
3. Set `FINDER=<name>`.

Nothing else in the engine knows which algorithm is running. Any implementation
must never return a merged-away or on-platform company, never exceed `limit`,
and keep `score` comparable within itself (scores from different finders are
not comparable with each other).

### The invite handshake

An invite is not a special kind of message: it is a transactional send carrying
a token, so consent and the sending rules apply to it like anything else. If
`can_send` refuses, no invite row is written and the blocked message is
returned with 200.

The marketplace implements three steps:

1. The invited company follows `GET /i/<token>`, which redirects 302 to
   `{MARKETPLACE_SIGNUP_URL}?invite=<token>`. An expired or already-used token
   gets a plain 410.
2. The signup form carries `invite` through to the account it creates.
3. Once the account exists, the marketplace calls
   `POST /internal/invites/accept` with `{ token, ref }` and the header
   `X-Internal-Token: <INTERNAL_TOKEN>` — its own key, not a tenant JWT. The
   engine marks the invite accepted, stamps `on_platform_ref = ref` on the
   company, expires any other open invites for it, and emits `invite.accepted`
   under the inviting tenant. A second accept is a 409.

From then on the company is out of the prospect pool's results.

## Promocodes

**Every amount is an integer in the currency's minor unit** — halalas for SAR,
never riyals and never a float. **A percent discount's `value` is basis
points**: `1000` is 10%. A computed discount is rounded down, capped by
`maxDiscount` and by the cart itself.

A code can be limited to products with `discount.productIds`, matched against
each cart item's `sku`. Then the discount, its cap and `minSubtotal` work on
those lines only. Validate and reserve both return `lines`: what comes off each
cart item, in the order sent, summing exactly to the discount.

The engine never moves money. It records who owes what against a `Ledger`, and
settlement between the parties is somebody else's job. `LEDGER=internal` (the
default) keeps that in a table here; `finance-engine` is a stub that fails
loudly until its endpoints exist.

### The checkout handshake

Four calls, in this order:

1. **Validate at the cart.** `POST /v1/promocodes/validate` while the buyer is
   still typing. An unusable code is a 200 with a `reason`, not an error —
   `not_found`, `not_active`, `currency_mismatch`, `no_eligible_items`,
   `min_subtotal`, `rule`, `budget_uses`, `budget_buyer` or `budget_spend`,
   whichever is true first.
   Nothing is written.
2. **Reserve at order placed.** `POST /v1/redemptions` with an `orderRef`. This
   locks the code, re-checks everything, writes a `reserved` redemption and
   places one hold per funder. `orderRef` is the idempotency key: the same
   order twice gets the same redemption and one set of holds, so a retried
   checkout cannot double-spend a budget.
3. **Settle at order completed.** `POST /v1/redemptions/:id/settle`, optionally
   with a `finalDiscountAmount` lower than reserved if the order shrank. What
   was used is captured; what was reserved and not used is released, so no hold
   is left open against a finished order.
4. **Release on cancel.** `POST /v1/redemptions/:id/release` with a reason.
   Reservations nobody settles or releases are let go automatically once
   `RESERVATION_TTL_MINUTES` has passed, by a job running every five minutes —
   otherwise an abandoned cart would hold budget against every other buyer
   forever.

Settling a released redemption, or releasing a settled one, is a 409. A refund
after settlement is a marketplace matter, not a promocode one.

`GET /v1/promocodes/reconcile` is the check that all of this held: per
currency, what the redemptions say was settled must equal what the ledger
captured, and what they say is still reserved must equal what it is still
holding.

### Funders

`funders` is `[{ party, share }]` with shares summing to 1, where a party is
`platform` or `tenant:<uuid>`. A discount that does not divide evenly puts the
remainder on the first funder, so the parts always sum to exactly the discount
— 1000 split three ways is 334, 333, 333.

### Two kinds of rule, opposite senses

Watch this one. A code's own `rules` document says when the code **may** be
used, so anything but `true` refuses it. A platform `promo_eligibility` row in
the `rules` table **denies** when it matches, like every other rule kind. Both
run on every validate, platform first, so a platform rule cannot be lifted by a
code.

## Campaigns

Contacts, audiences and campaigns live in `src/modules/campaigns/`. A campaign
is a scheduler and a recipient list: every recipient goes out through
`messaging.send()`, so consent, rules, channel selection, templates and
fallback apply exactly as they do to a single send. `docs/API.md` has the
routes; the short version is:

1. **Contacts** — `POST /v1/contacts`, or `POST /v1/contacts/import` with a CSV.
   Consent is recorded only for rows that carry the evidence (channels, purpose,
   source, date). Having someone's number is never consent.
2. **Audience** — a static list, or a finder search resolved at run time.
3. **Preview** — `POST /v1/audiences/:id/preview` says who would actually get a
   send, and why the rest would not. Show it before scheduling.
4. **Campaign** — `POST /v1/campaigns`, then `/schedule`. One-shot or a
   five-field cron in the campaign's time zone.

Each run snapshots the audience when it starts, then sends in batches. A
blocked recipient is terminal and is never retried; a recipient that could not
be sent at all (no template for the channel picked, say) is `skipped` with the
reason.

`POST /v1/messages` does not schedule anything: its `evaluateAt` only moves the
clock the sending window is checked against. To send later, use a campaign.

### The numbers, and where to change them

| Number | Value | Where |
| --- | --- | --- |
| Send rate per campaign | `throttlePerMinute`, 1..600, default 60 | per campaign; the bounds are in `src/api/routes/campaigns.ts` and a check constraint in `0013_campaigns.sql` |
| Batch spacing | every 10 s, each a tenth of the minute's allowance (`ceil(throttle / 6)`) | `BATCH_INTERVAL_SECONDS` in `src/modules/campaigns/campaigns.ts` |
| Campaigns running at once, per tenant | 5 | `MAX_RUNNING_PER_TENANT`, same file |
| Wait when a tenant is at that limit | 60 s, then the run tries again | `BACKPRESSURE_SECONDS` in `src/modules/campaigns/worker.ts` |
| Largest audience a run snapshots | 100,000 contacts | `MAX_AUDIENCE` in `src/modules/campaigns/audiences.ts` |
| Contacts per import | 20,000 rows | `MAX_CONTACT_IMPORT_ROWS` in `src/modules/campaigns/contacts.ts` |
| Step when searching for the next open sending window | 15 minutes | `WINDOW_STEP_MINUTES` in `src/modules/campaigns/window.ts` |
| How far ahead that search looks | 7 days, then `blocked no_sending_window` | `WINDOW_HORIZON_DAYS`, same file |
| Stalled-run sweep | every 5 minutes; expanding idle 10 min, sending idle 5 min | `SWEEP_CRON` and the thresholds in `src/modules/campaigns/sweep.ts` |
| Unexpected errors before a recipient is skipped | 3 | `POISON_ATTEMPTS` in `src/modules/campaigns/worker.ts` |
| pg-boss retries per campaign job | 3, with backoff | `JOB_RETRY_LIMIT` in `src/modules/campaigns/campaigns.ts` |

**The concurrency limit of 5 is a number to revisit.** It is the crude
backpressure that keeps one tenant from monopolising the queue: scheduling or
resuming a sixth is a `409 too_many_running`, and a run whose time comes while
the tenant is at the limit waits a minute and tries again. It says nothing
about total throughput across tenants, which is bounded only by the send
worker. Change it once real tenants show what they need.

**A closed sending window defers, it does not drop.** A campaign batch that
reaches a Saudi recipient after 21:00 local leaves them pending until 09:00 and
carries on; the run stays `sending` until the deferred ones have gone. Only a
window that does not open within 7 days blocks (`no_sending_window`). Consent
and suppression are never deferred.

The 15-minute step, the 7-day horizon and the 5-minute sweep are numbers to
revisit once real campaigns show how they behave.

## Running it in production

`docker-compose.prod.yml` runs three things: the engine, its Postgres, and a
container that dumps the database every night. Put the environment in
`.env.prod` (see `.env.example`) and set `POSTGRES_PASSWORD`:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The image runs as the `node` user, applies migrations before taking traffic
(they are forward-only and idempotent, so a restart or a second replica is
harmless) and carries a `HEALTHCHECK` on `/health`. Shutdown is graceful: the
server stops accepting requests, in-flight ones finish, and pg-boss is told to
stop cleanly — whatever it does not finish stays on the queue for the next
process, so no send is lost.

### Backups, and restoring from one

The `backup` container writes `marketing-<timestamp>.dump` to the `engine_backups`
volume once a day, covering the `marketing` and `pgboss` schemas, and deletes
dumps older than 14 days *after* a successful write, so a run of failures never
eats the last good one.

To restore one — these are the commands, run as written against a real dump:

```bash
# 1. Find the dump you want.
docker compose -f docker-compose.prod.yml exec backup ls -l /backups

# 2. Create the target database AND the pg_trgm extension. The dump covers the
#    marketing and pgboss schemas only, so the extension is not in it; without
#    this step the trigram index on company names is silently skipped and
#    free-text discovery comes back broken rather than missing.
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U postgres -c 'create database marketing_restored'
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U postgres -d marketing_restored -c 'create extension if not exists pg_trgm'

# 3. Load it.
docker compose -f docker-compose.prod.yml exec postgres \
  pg_restore -U postgres -d marketing_restored --no-owner --role=postgres \
  /backups/marketing-<timestamp>.dump

# 4. Check it came back whole.
docker compose -f docker-compose.prod.yml exec postgres psql -U postgres \
  -d marketing_restored -c "select count(*) from marketing.events"
```

A restore done this way reports zero errors. Point `DATABASE_URL` at the
restored database to cut over.

## The operator dashboard

A screen for whoever runs this: the queue, every tenant's traffic, a live event
feed, and the two actions worth having (retry a failed job, replay a failed
delivery). It lives in `dashboard/` as a **separate static app** with its own
container. The engine still serves only JSON; deleting `dashboard/` changes
nothing in it.

### Running it locally

```bash
cd dashboard
npm install
cp .env.local.example .env.local   # point ENGINE_URL at your engine
npm run dev                        # http://localhost:5173
```

The dev server proxies `/api/` to the engine's `/internal/` and adds
`X-Internal-Token` itself, so **the token never reaches the browser or the
bundle**. There is no basic auth in development.

### Deploying it

The container is nginx serving the built files, with basic auth in front and
the token added on the way through. Create the password file first — never
commit one:

```bash
# bcrypt, one line per user
docker run --rm httpd:alpine htpasswd -nbB operator 'a-long-password' \
  > dashboard/htpasswd

docker compose -f docker-compose.prod.yml up -d --build dashboard
```

It listens on `127.0.0.1:8443`. **Terminate TLS in front of it** — basic auth
over plain HTTP sends the password in clear. Caddy is one line:

```
dashboard.example.com { reverse_proxy 127.0.0.1:8443 }
```

The container refuses to start without `INTERNAL_TOKEN` or an htpasswd file,
rather than coming up and failing every request.

### What it will not do

It renders; the engine decides. No number on the screen is computed in the
browser — if something is missing, it gets added to the `/internal/` API, not to
the UI. `docs/DASHBOARD.md` explains which endpoint feeds which view.

## Tenant isolation

Every tenant table has `tenant_id` and row-level security. Requests run inside
`withTenant()`, which opens a transaction, sets `app.tenant_id` and switches to
the non-owning `marketing_app` role — so the RLS policies actually apply rather
than being bypassed by the table owner. `events` is append-only: `marketing_app`
is granted `select, insert` and nothing more.
