-- 0016_discovery_jobs: the base of web discovery (steps 17-21). Profiles learn
-- what a company says it sells and where, the registry learns Google Maps ids
-- and web provenance, and an operator's search becomes a job that runs one
-- task per country on the queue and keeps its ranked results.

-- ---------------------------------------------------------------------------
-- company_profiles: what web evidence says about a company
-- ---------------------------------------------------------------------------
-- Shared like the rest of the profile. `products` is free text in the
-- company's own words, any language; `sells` keeps its meaning (category
-- codes) and is not touched.
alter table marketing.company_profiles
  add column if not exists products    text[] not null default '{}',
  add column if not exists roles       text[] not null default '{}',
  add column if not exists cities      text[] not null default '{}',
  add column if not exists countries   text[] not null default '{}',
  add column if not exists quality     text null,
  add column if not exists profiled_at timestamptz null;

-- Whether every element is an ISO 3166-1 alpha-2 code in upper case. A
-- function, because a check constraint cannot look inside an array: matching
-- the joined string would let a NULL element or an 'SA,AE' element through.
create or replace function marketing.is_country_codes(codes text[]) returns boolean
language sql immutable parallel safe
as $$
  select coalesce(bool_and(coalesce(c ~ '^[A-Z]{2}$', false)), true) from unnest(codes) as c
$$;

-- Whether no element appears twice.
create or replace function marketing.is_distinct_list(items text[]) returns boolean
language sql immutable parallel safe
as $$
  select count(*) = count(distinct i) from unnest(items) as i
$$;

alter table marketing.company_profiles
  drop constraint if exists company_profiles_roles_check,
  add constraint company_profiles_roles_check check (
    roles <@ array['manufacturer', 'distributor', 'wholesaler', 'retailer',
                   'installer', 'service_provider', 'transporter', 'other']::text[]
  ),
  drop constraint if exists company_profiles_countries_check,
  add constraint company_profiles_countries_check check (marketing.is_country_codes(countries)),
  drop constraint if exists company_profiles_quality_check,
  add constraint company_profiles_quality_check check (quality in ('full', 'thin'));

-- ---------------------------------------------------------------------------
-- fold_text: the letter folding of names.ts foldText(), in SQL
-- ---------------------------------------------------------------------------
-- The products finder folds both its terms and the stored product names with
-- this at query time, so the two sides of a comparison always fold the same
-- way, without keeping a second, folded copy of every profile. Lower case, Arabic marks
-- and tatweel stripped, أ/إ/آ/ٱ → ا, ة → ه, ى/ئ → ي, ؤ → و, anything that is
-- not a letter or digit to one space. test/discovery-jobs.test.ts holds the
-- two to the same answers.
create or replace function marketing.fold_text(input text) returns text
language sql immutable parallel safe
as $$
  select btrim(regexp_replace(
    translate(
      regexp_replace(lower(input), '[ؐ-ًؚ-ٰٟۖ-ۭـ]', '', 'g'),
      'أإآٱةىئؤ',
      'ااااهييو'
    ),
    '[^[:alnum:]]+', ' ', 'g'
  ))
$$;

grant execute on function marketing.fold_text(text) to marketing_app;

-- ---------------------------------------------------------------------------
-- registry: Google Maps ids, and web and Maps provenance
-- ---------------------------------------------------------------------------
-- gmaps is strong: a place id names one place, so two records carrying it are
-- the same company.
alter table marketing.company_identifiers
  drop constraint if exists company_identifiers_type_check,
  add constraint company_identifiers_type_check
    check (type in ('cr', 'vat', 'domain', 'phone', 'email', 'gmaps'));

alter table marketing.company_sources
  drop constraint if exists company_sources_source_type_check,
  add constraint company_sources_source_type_check
    check (source_type in ('rfq', 'import', 'api', 'lookup', 'web', 'maps'));

-- ---------------------------------------------------------------------------
-- discovery_jobs
-- ---------------------------------------------------------------------------
-- One operator search: a product and the countries to look in. Private to the
-- tenant it was created for.
create table if not exists marketing.discovery_jobs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references marketing.tenants (id),
  product      text not null check (char_length(product) between 2 and 200),
  category     text null check (char_length(category) <= 200),
  side         text not null default 'suppliers' check (side in ('suppliers')),
  countries    text[] not null check (
                 cardinality(countries) between 1 and 10
                 and marketing.is_country_codes(countries)
                 and marketing.is_distinct_list(countries)
               ),
  -- Search terms. Step 19 fills them; until then a job ranks on its product.
  terms        text[] not null default '{}',
  result_limit int not null default 50 check (result_limit between 1 and 200),
  status       text not null check (status in ('running', 'done', 'failed')),
  -- The sum of its tasks' counts, written when the last task finishes.
  counts       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz null
);

create index if not exists discovery_jobs_tenant_created_idx
  on marketing.discovery_jobs (tenant_id, created_at desc);

alter table marketing.discovery_jobs enable row level security;

drop policy if exists discovery_jobs_isolation on marketing.discovery_jobs;
create policy discovery_jobs_isolation on marketing.discovery_jobs
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.discovery_jobs to marketing_app;

-- ---------------------------------------------------------------------------
-- discovery_tasks
-- ---------------------------------------------------------------------------
-- One country of a job, and the unit the queue retries. `stage` is the stage
-- running now, or the last one that ran.
create table if not exists marketing.discovery_tasks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references marketing.tenants (id),
  job_id      uuid not null references marketing.discovery_jobs (id),
  country     text not null,
  status      text not null check (status in ('queued', 'running', 'done', 'failed')),
  stage       text null,
  counts      jsonb not null default '{}'::jsonb,
  error       text null,
  attempts    int not null default 0,
  created_at  timestamptz not null default now(),
  started_at  timestamptz null,
  finished_at timestamptz null,
  unique (job_id, country)
);

alter table marketing.discovery_tasks enable row level security;

drop policy if exists discovery_tasks_isolation on marketing.discovery_tasks;
create policy discovery_tasks_isolation on marketing.discovery_tasks
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.discovery_tasks to marketing_app;

-- ---------------------------------------------------------------------------
-- discovery_results
-- ---------------------------------------------------------------------------
-- A task's ranked companies. Delete is granted because a re-run replaces a
-- task's results rather than adding to them.
create table if not exists marketing.discovery_results (
  id         bigserial primary key,
  tenant_id  uuid not null references marketing.tenants (id),
  job_id     uuid not null references marketing.discovery_jobs (id),
  task_id    uuid not null references marketing.discovery_tasks (id),
  company_id uuid not null references marketing.companies (id),
  rank       int not null,
  score      real not null,
  reasons    text[] not null,
  created_at timestamptz not null default now(),
  unique (task_id, company_id)
);

create index if not exists discovery_results_job_rank_idx
  on marketing.discovery_results (job_id, rank);

alter table marketing.discovery_results enable row level security;

drop policy if exists discovery_results_isolation on marketing.discovery_results;
create policy discovery_results_isolation on marketing.discovery_results
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, delete on marketing.discovery_results to marketing_app;
grant usage on sequence marketing.discovery_results_id_seq to marketing_app;
