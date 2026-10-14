-- 0024_discovery_term_langs: each persona term's language, as the personas
-- step gave it, so a term is searched in its own language rather than one
-- guessed from its alphabet. Term → ISO 639-1 code; rows from before this
-- migration have none and keep the guess.
alter table marketing.discovery_personas
  add column if not exists term_langs jsonb not null default '{}';
