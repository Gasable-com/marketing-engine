-- 0015_buyer_company_ref: the client's own id for the buying company.
-- Opaque like buyer_ref: stored and reported, never looked up. company_id
-- stays what it was, a registry id, and only for companies the engine knows.
alter table marketing.redemptions add column if not exists buyer_company_ref text null;
