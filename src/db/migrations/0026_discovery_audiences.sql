-- 0026_discovery_audiences: found buyers as an audience (brief 26). An
-- audience may be `discovery`: the companies a requester's finished searches
-- ranked. The outreach contacts the engine makes for them are hidden from the
-- tenant, and the `outreach` purpose keeps to the same sending window as
-- marketing while needing no consent.

-- ---------------------------------------------------------------------------
-- audiences: the discovery kind
-- ---------------------------------------------------------------------------
alter table marketing.audiences
  drop constraint if exists audiences_kind_check,
  add constraint audiences_kind_check check (kind in ('static', 'search', 'discovery'));

-- ---------------------------------------------------------------------------
-- contacts: hidden outreach contacts
-- ---------------------------------------------------------------------------
-- An outreach contact the engine made for a found company. Never listed or
-- fetched, and shown nowhere with its addresses. It becomes a normal contact
-- the moment the tenant stores the same address itself.
alter table marketing.contacts
  add column if not exists hidden boolean not null default false;

-- ---------------------------------------------------------------------------
-- The Saudi sending window applies to outreach as it does to marketing
-- ---------------------------------------------------------------------------
-- The consent row is the only one outreach skips. The seeded rule named
-- marketing alone; it now names both. A row an operator has already changed
-- is left as it is.
update marketing.rules
set document = jsonb_set(document, '{and,1}', '{"in": [{"var": "purpose"}, ["marketing", "outreach"]]}'::jsonb)
where name = 'sa-marketing-sms-hours'
  and scope = 'region' and region = 'SA' and kind = 'sending_window'
  and document #> '{and,1}' = '{"==": [{"var": "purpose"}, "marketing"]}'::jsonb;
