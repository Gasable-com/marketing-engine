-- 0021_discovery_clarify: a job whose product Claude cannot pin down waits for
-- the operator instead of searching for a guess. needs_input is that wait;
-- clarification is what the operator said the product is.
alter table marketing.discovery_jobs
  drop constraint if exists discovery_jobs_status_check,
  add constraint discovery_jobs_status_check
    check (status in ('planning', 'needs_input', 'running', 'done', 'failed'));

alter table marketing.discovery_jobs
  add column if not exists clarification text null
    check (char_length(clarification) between 2 and 200);
