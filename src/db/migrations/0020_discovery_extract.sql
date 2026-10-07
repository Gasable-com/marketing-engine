-- 0020_discovery_extract: reading what a search found. Candidates are marked
-- one by one as they are read and extracted, so a resumed task carries on
-- where it stopped; results carry the persona and the checked evidence; and a
-- job counts its Claude calls against its budget as it makes them.

alter table marketing.discovery_candidates
  drop constraint if exists discovery_candidates_status_check,
  add constraint discovery_candidates_status_check
    check (status in ('new', 'kept', 'dropped', 'extracted', 'not_saved', 'failed')),
  -- Checked quotes only, with the page each came from: { signal, claim, quote, url }.
  add column if not exists evidence jsonb not null default '[]'::jsonb;

alter table marketing.discovery_results
  add column if not exists persona_id uuid null references marketing.discovery_personas (id),
  add column if not exists fit        text null check (fit in ('strong', 'weak')),
  add column if not exists tier       text not null default 'pool' check (tier in ('found', 'pool')),
  add column if not exists evidence   jsonb not null default '[]'::jsonb;

-- Every Claude call a job makes, planning, triage and extraction alike, is
-- reserved here first; past DISCOVERY_MAX_CLAUDE_CALLS the job makes no more.
alter table marketing.discovery_jobs
  add column if not exists claude_calls int not null default 0;
