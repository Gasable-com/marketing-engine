-- 0023_discovery_portal: discovery from the marketplace portal. A search
-- knows who asked and for which catalog product; a corporate's RFQ becomes
-- one RFQ search with one product search per line; and a quota rule limits
-- how many searches one requester may start.

-- ---------------------------------------------------------------------------
-- discovery_rfq_searches
-- ---------------------------------------------------------------------------
create table if not exists marketing.discovery_rfq_searches (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references marketing.tenants (id),
  rfq_ref       text null check (char_length(rfq_ref) <= 200),
  requester_ref text null check (char_length(requester_ref) <= 200),
  side          text not null default 'suppliers' check (side in ('suppliers', 'buyers')),
  countries     text[] not null check (
                  cardinality(countries) between 1 and 10
                  and marketing.is_country_codes(countries)
                  and marketing.is_distinct_list(countries)
                ),
  status        text not null check (status in ('running', 'done', 'failed')),
  -- Its lines' counts summed, written when the last line finishes.
  counts        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz null
);

create index if not exists discovery_rfq_searches_requester_idx
  on marketing.discovery_rfq_searches (tenant_id, requester_ref, created_at desc);

alter table marketing.discovery_rfq_searches enable row level security;

drop policy if exists discovery_rfq_searches_isolation on marketing.discovery_rfq_searches;
create policy discovery_rfq_searches_isolation on marketing.discovery_rfq_searches
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.discovery_rfq_searches to marketing_app;

-- ---------------------------------------------------------------------------
-- discovery_jobs: who asked, for which product, and which RFQ line it is
-- ---------------------------------------------------------------------------
alter table marketing.discovery_jobs
  add column if not exists requester_ref text null check (char_length(requester_ref) <= 200),
  add column if not exists product_ref   text null check (char_length(product_ref) <= 200),
  add column if not exists rfq_search_id uuid null references marketing.discovery_rfq_searches (id),
  add column if not exists line_ref      text null check (char_length(line_ref) <= 200),
  add column if not exists line_position int null;

create index if not exists discovery_jobs_requester_idx
  on marketing.discovery_jobs (tenant_id, requester_ref, created_at desc);
create index if not exists discovery_jobs_product_ref_idx
  on marketing.discovery_jobs (tenant_id, product_ref) where product_ref is not null;
create index if not exists discovery_jobs_rfq_idx
  on marketing.discovery_jobs (rfq_search_id, line_position) where rfq_search_id is not null;

-- ---------------------------------------------------------------------------
-- discovery.quota: how many searches one requester may start
-- ---------------------------------------------------------------------------
-- A value rule, read with rules.decide; a tenant row sets its own numbers.
-- Days and months are calendar ones in `timezone`.
insert into marketing.rules (scope, kind, name, document)
select 'platform', 'discovery.quota', 'Searches per requester',
  '{"if": [true, {"day": 5, "month": 50, "timezone": "Asia/Riyadh"}, null]}'::jsonb
where not exists (
  select 1 from marketing.rules where kind = 'discovery.quota' and scope = 'platform'
);
