-- 0017_discovery_planning: a job learns what it is searching for before it
-- searches. It may now look for buyers as well as suppliers, plans once (what
-- the product is, and the personas to search for) before its per-country
-- tasks run, and can wait out a Claude usage limit instead of failing.

-- ---------------------------------------------------------------------------
-- discovery_jobs
-- ---------------------------------------------------------------------------
alter table marketing.discovery_jobs
  drop constraint if exists discovery_jobs_side_check,
  add constraint discovery_jobs_side_check check (side in ('suppliers', 'buyers')),
  drop constraint if exists discovery_jobs_status_check,
  add constraint discovery_jobs_status_check
    check (status in ('planning', 'running', 'done', 'failed'));

alter table marketing.discovery_jobs
  -- Claude's identification of the product, as validated.
  add column if not exists identified     jsonb null,
  add column if not exists stages_done    text[] not null default '{}',
  add column if not exists error          text null,
  add column if not exists attempts       int not null default 0,
  add column if not exists deferrals      int not null default 0,
  add column if not exists started_at     timestamptz null,
  add column if not exists deferred_until timestamptz null,
  -- The row the operator pasted, when the search started from one.
  add column if not exists source_row     text null
    check (char_length(source_row) <= 5000);

-- ---------------------------------------------------------------------------
-- discovery_tasks
-- ---------------------------------------------------------------------------
alter table marketing.discovery_tasks
  add column if not exists stages_done    text[] not null default '{}',
  add column if not exists deferrals      int not null default 0,
  add column if not exists deferred_until timestamptz null;

-- ---------------------------------------------------------------------------
-- discovery_personas
-- ---------------------------------------------------------------------------
-- The kinds of company a job searches for, in Claude's order. Delete is
-- granted because planning again replaces them.
create table if not exists marketing.discovery_personas (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references marketing.tenants (id),
  job_id       uuid not null references marketing.discovery_jobs (id),
  position     int not null,
  name         text not null,
  description  text not null,
  roles        text[] not null default '{}',
  sectors      text[] not null default '{}',
  search_terms text[] not null default '{}',
  places_terms text[] not null default '{}',
  signals      text[] not null default '{}',
  created_at   timestamptz not null default now(),
  unique (job_id, position)
);

alter table marketing.discovery_personas enable row level security;

drop policy if exists discovery_personas_isolation on marketing.discovery_personas;
create policy discovery_personas_isolation on marketing.discovery_personas
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, delete on marketing.discovery_personas to marketing_app;
