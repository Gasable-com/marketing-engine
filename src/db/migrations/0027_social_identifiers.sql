-- 0027_social_identifiers: a company's social profiles (brief 27). `social`
-- is weak: a page can link its parent's, a franchise brand's or its web
-- agency's profile, so it links a company and never merges two. The value is
-- the profile's canonical form from canonicalSocial(); `unique (type, value)`
-- and the company index already cover it.
alter table marketing.company_identifiers
  drop constraint if exists company_identifiers_type_check,
  add constraint company_identifiers_type_check
    check (type in ('cr', 'vat', 'domain', 'phone', 'email', 'gmaps', 'social'));
