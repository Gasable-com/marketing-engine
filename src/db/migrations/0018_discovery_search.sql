-- 0018_discovery_search: searching the web and Maps for a job's personas.
-- A shared cache of trimmed search results, the candidates each task found,
-- and two rule kinds: how to search a country, and hosts never to keep.

-- ---------------------------------------------------------------------------
-- search_queries: shared, like the pool
-- ---------------------------------------------------------------------------
-- Public search results are the same whoever asks, so they are cached once
-- for every tenant. Only the trimmed fields the adapter keeps are stored;
-- rows older than 90 days are pruned by discovery.cache.prune.
create table if not exists marketing.search_queries (
  id           bigserial primary key,
  provider     text not null,
  kind         text not null check (kind in ('web', 'places')),
  q            text not null,
  gl           text not null,
  hl           text not null,
  page         int not null default 1,
  results      jsonb not null,
  result_count int not null,
  fetched_at   timestamptz not null default now(),
  unique (provider, kind, q, gl, hl, page)
);

create index if not exists search_queries_fetched_idx on marketing.search_queries (fetched_at);

alter table marketing.search_queries enable row level security;

drop policy if exists search_queries_shared on marketing.search_queries;
create policy search_queries_shared on marketing.search_queries
  for all to marketing_app using (true) with check (true);

grant select, insert, update on marketing.search_queries to marketing_app;
grant usage on sequence marketing.search_queries_id_seq to marketing_app;

-- ---------------------------------------------------------------------------
-- discovery_candidates: what a task's searches found, one row per company
-- ---------------------------------------------------------------------------
create table if not exists marketing.discovery_candidates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references marketing.tenants (id),
  job_id      uuid not null references marketing.discovery_jobs (id),
  task_id     uuid not null references marketing.discovery_tasks (id),
  kind        text not null check (kind in ('web', 'maps', 'both')),
  domain      text null,
  gmaps       text null,
  name        text not null,
  url         text null,
  phone       text null,
  address     text null,
  category    text null,
  -- At most five { query, title, snippet }: why the search surfaced it.
  snippets    jsonb not null default '[]'::jsonb,
  persona_ids uuid[] not null default '{}',
  fit         text null check (fit in ('strong', 'weak')),
  company_id  uuid null references marketing.companies (id),
  status      text not null default 'new' check (status in ('new', 'kept', 'dropped')),
  reason      text null,
  created_at  timestamptz not null default now(),
  check (domain is not null or gmaps is not null)
);

create unique index if not exists discovery_candidates_task_domain_idx
  on marketing.discovery_candidates (task_id, domain) where domain is not null;
create unique index if not exists discovery_candidates_task_gmaps_idx
  on marketing.discovery_candidates (task_id, gmaps) where gmaps is not null;
create index if not exists discovery_candidates_job_idx
  on marketing.discovery_candidates (job_id, status);

alter table marketing.discovery_candidates enable row level security;

drop policy if exists discovery_candidates_isolation on marketing.discovery_candidates;
create policy discovery_candidates_isolation on marketing.discovery_candidates
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update, delete on marketing.discovery_candidates to marketing_app;

-- ---------------------------------------------------------------------------
-- rule kinds: discovery.country and discovery.blocked_hosts
-- ---------------------------------------------------------------------------
insert into marketing.regions (code, timezone) values ('AE', 'Asia/Dubai')
  on conflict (code) do nothing;

-- discovery.country: how to search one country, read with rules.decide for
-- the task's country. A value rule: `{"if": [true, settings, null]}`. Cities
-- carry both languages so a term is paired with the city in its own script;
-- `names` are the country's own names, which persona terms may not contain.
insert into marketing.rules (scope, region, kind, name, document)
select 'region', 'SA', 'discovery.country', 'Search Saudi Arabia',
  '{"if": [true, {
     "gl": "sa",
     "languages": ["ar", "en"],
     "suffix": {"en": "Saudi Arabia", "ar": "السعودية"},
     "names": ["saudi", "saudi arabia", "ksa", "السعودية", "المملكة العربية السعودية"],
     "cities": [
       {"en": "Riyadh", "ar": "الرياض"}, {"en": "Jeddah", "ar": "جدة"}, {"en": "Dammam", "ar": "الدمام"},
       {"en": "Mecca", "ar": "مكة"}, {"en": "Medina", "ar": "المدينة المنورة"}, {"en": "Khobar", "ar": "الخبر"},
       {"en": "Jubail", "ar": "الجبيل"}, {"en": "Yanbu", "ar": "ينبع"}, {"en": "Tabuk", "ar": "تبوك"},
       {"en": "Abha", "ar": "أبها"}, {"en": "Dhahran", "ar": "الظهران"}, {"en": "Qassim", "ar": "القصيم"}
     ]}, null]}'::jsonb
where not exists (
  select 1 from marketing.rules where kind = 'discovery.country' and scope = 'region' and region = 'SA'
);

insert into marketing.rules (scope, region, kind, name, document)
select 'region', 'AE', 'discovery.country', 'Search the UAE',
  '{"if": [true, {
     "gl": "ae",
     "languages": ["en", "ar"],
     "suffix": {"en": "UAE", "ar": "الإمارات"},
     "names": ["uae", "emirates", "united arab emirates", "الإمارات", "الامارات"],
     "cities": [
       {"en": "Dubai", "ar": "دبي"}, {"en": "Abu Dhabi", "ar": "أبوظبي"}, {"en": "Sharjah", "ar": "الشارقة"},
       {"en": "Ajman", "ar": "عجمان"}, {"en": "Al Ain", "ar": "العين"}, {"en": "Ras Al Khaimah", "ar": "رأس الخيمة"},
       {"en": "Fujairah", "ar": "الفجيرة"}
     ]}, null]}'::jsonb
where not exists (
  select 1 from marketing.rules where kind = 'discovery.country' and scope = 'region' and region = 'AE'
);

-- discovery.blocked_hosts: a deny rule checked per candidate domain with
-- context { host }. The platform list holds directories, marketplaces, job
-- boards, news and reference sites that list companies without being one.
-- A tenant adds hosts with a row of its own and can never lift these.
insert into marketing.rules (scope, kind, name, document)
select 'platform', 'discovery.blocked_hosts', 'Directories, marketplaces, news and job boards',
  '{"in": [{"var": "host"}, [
     "wikipedia.org", "wikimedia.org", "pinterest.com", "quora.com", "reddit.com",
     "scribd.com", "issuu.com", "slideshare.net", "researchgate.net", "sciencedirect.com",
     "amazon.com", "amazon.sa", "amazon.ae", "noon.com", "alibaba.com", "aliexpress.com",
     "made-in-china.com", "indiamart.com", "tradeindia.com", "globalsources.com", "ec21.com",
     "dubizzle.com", "dubizzle.sa", "olx.com", "expatriates.com",
     "kompass.com", "dnb.com", "opencorporates.com", "zoominfo.com", "crunchbase.com",
     "yellowpages.com.sa", "saudiyellowpages.com", "yellowpages.ae", "yellowpages-uae.com",
     "daleeli.com", "yello.ae", "cybo.com", "zaubee.com", "connect.ae", "2gis.ae", "infoisinfo.com",
     "bayt.com", "naukrigulf.com", "indeed.com", "glassdoor.com", "gulftalent.com",
     "zawya.com", "argaam.com", "arabnews.com", "gulfnews.com", "khaleejtimes.com", "thenationalnews.com",
     "aleqt.com", "sabq.org", "okaz.com.sa", "alarabiya.net", "aljazeera.net", "bloomberg.com", "reuters.com",
     "spa.gov.sa", "my.gov.sa", "mc.gov.sa", "tripadvisor.com", "booking.com"
   ]]}'::jsonb
where not exists (
  select 1 from marketing.rules where kind = 'discovery.blocked_hosts' and scope = 'platform'
);
