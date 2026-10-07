-- 0022_discovery_identify_first: the product question moves to before a
-- search exists (POST /internal/discovery/identify), so a job never waits for
-- the operator. Undoes 0021's needs_input status and clarification, and
-- records instead whether the operator confirmed the product up front.

-- A search left waiting under 0021 is closed: the new flow asks before
-- searching, and nobody will answer this one.
update marketing.discovery_jobs
set status = 'failed', error = 'closed: the product is now confirmed before a search starts',
    finished_at = now()
where status = 'needs_input';

alter table marketing.discovery_jobs
  drop constraint if exists discovery_jobs_status_check,
  add constraint discovery_jobs_status_check
    check (status in ('planning', 'running', 'done', 'failed'));

alter table marketing.discovery_jobs drop column if exists clarification;

alter table marketing.discovery_jobs
  add column if not exists product_confirmed boolean not null default false;
