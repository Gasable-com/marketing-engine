import { db, withTenant } from '../../../db/client.js';
import { env } from '../../../env.js';
import { findByIdentifier, isSharedHost, normalizeDomain, normalizeIdentifiers } from '../../../spine/registry/index.js';
import { ask, bridgeConfigured } from '../claude.js';
import { PermanentError, UsageLimitError } from '../errors.js';
import type { Counts, JobRow, PersonaRow, TaskRow } from '../jobs.js';
import { Triage, triagePrompt, type Verdict } from '../prompts.js';
import { placesSearch, webSearch } from './cache.js';
import { countrySettings, isArabic, isBlockedHost, type CountrySettings } from './country.js';
import { serperConfigured } from './serper.js';

/**
 * The `search` and `triage` stages. Search asks Serper for every persona in
 * the task's country and groups what comes back into candidates, one per
 * company; triage has Claude keep the ones that look like a persona.
 */

export const searchNeeds = () => serperConfigured() && bridgeConfigured();

const TRIAGE_BATCH = 40;
const MAX_SNIPPETS = 5;
const MAX_REASON = 120;

type Planned = { kind: 'web' | 'places'; q: string; hl: string; personaId: string };

async function personasOf(job: JobRow): Promise<PersonaRow[]> {
  return withTenant(job.tenant_id, (tx) => tx<PersonaRow[]>`
    select * from discovery_personas where job_id = ${job.id} order by position
  `);
}

/**
 * Every query one persona wants in this country, in the order to ask them:
 * web and Maps alternating, so a cap never leaves out Maps. Only terms in one
 * of the country's languages are asked.
 */
function queriesFor(persona: PersonaRow, country: CountrySettings): Planned[] {
  const web: Planned[] = [];
  for (const term of persona.search_terms) {
    const hl = isArabic(term) ? 'ar' : 'en';
    if (!country.languages.includes(hl)) continue;
    web.push({ kind: 'web', q: term, hl, personaId: persona.id });
    const suffix = country.suffix[hl];
    if (suffix) web.push({ kind: 'web', q: `${term} ${suffix}`, hl, personaId: persona.id });
  }
  const places: Planned[] = [];
  for (const term of persona.places_terms) {
    const hl = isArabic(term) ? 'ar' : 'en';
    if (!country.languages.includes(hl)) continue;
    places.push({ kind: 'places', q: term, hl, personaId: persona.id });
    for (const city of country.cities.slice(0, 3)) {
      const name = city[hl] ?? city['en'];
      if (name) places.push({ kind: 'places', q: `${term} ${name}`, hl, personaId: persona.id });
    }
  }
  const out: Planned[] = [];
  for (let i = 0; i < Math.max(web.length, places.length); i += 1) {
    if (web[i]) out.push(web[i]!);
    if (places[i]) out.push(places[i]!);
  }
  return out;
}

/** Personas take turns, so a cap never starves the later ones. */
function interleave(lists: Planned[][]): Planned[] {
  const out: Planned[] = [];
  const seen = new Set<string>();
  for (let i = 0; lists.some((l) => i < l.length); i += 1) {
    for (const list of lists) {
      const q = list[i];
      if (!q) continue;
      const key = `${q.kind}|${q.hl}|${q.q.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(q);
    }
  }
  return out;
}

type Candidate = {
  kind: 'web' | 'maps' | 'both';
  domain: string | null;
  gmaps: string | null;
  /** Google's place id, when Serper gave one: a second way to know a listing. */
  placeId: string | null;
  name: string;
  url: string | null;
  phone: string | null;
  address: string | null;
  category: string | null;
  snippets: { query: string; title: string; snippet: string }[];
  personaIds: Set<string>;
  status: 'new' | 'dropped';
  reason: string | null;
};

function blank(fields: Partial<Candidate> & Pick<Candidate, 'kind' | 'name'>): Candidate {
  return {
    domain: null,
    gmaps: null,
    placeId: null,
    url: null,
    phone: null,
    address: null,
    category: null,
    snippets: [],
    personaIds: new Set(),
    status: 'new',
    reason: null,
    ...fields,
  };
}

function note(c: Candidate, query: string, title: string, snippet: string, personaId: string) {
  c.personaIds.add(personaId);
  if (c.snippets.length < MAX_SNIPPETS) c.snippets.push({ query, title: title.slice(0, 200), snippet: snippet.slice(0, 300) });
}

export async function runSearch(job: JobRow, task: TaskRow): Promise<Counts> {
  const e = env();
  const country = await countrySettings(job.tenant_id, task.country);
  const personas = await personasOf(job);
  if (personas.length === 0) return { queries: 0 };

  // Each task gets its share of the job's cap; a share of 0 searches nothing.
  const cap = Math.min(e.DISCOVERY_MAX_QUERIES, Math.floor(e.DISCOVERY_MAX_QUERIES_PER_JOB / job.countries.length));
  const planned = interleave(personas.map((p) => queriesFor(p, country)));
  const queries = planned.slice(0, cap);

  const byDomain = new Map<string, Candidate>();
  const byPlace = new Map<string, Candidate>();
  const dropped = new Map<string, Candidate>();
  const blockedCache = new Map<string, boolean>();
  const blocked = async (host: string) => {
    if (!blockedCache.has(host)) blockedCache.set(host, await isBlockedHost(job.tenant_id, task.country, host));
    return blockedCache.get(host)!;
  };

  let serperCalls = 0;
  let cacheHits = 0;
  let hits = 0;
  const places: { q: string; personaId: string; hit: Awaited<ReturnType<typeof placesSearch>>['hits'][number] }[] = [];

  for (const query of queries) {
    const params = { q: query.q, gl: country.gl, hl: query.hl };
    if (query.kind === 'web') {
      const result = await webSearch(params);
      result.fromCache ? (cacheHits += 1) : (serperCalls += 1);
      for (const hit of result.hits) {
        hits += 1;
        const domain = normalizeDomain(hit.link);
        if (!domain) continue;
        if (isSharedHost(domain) || (await blocked(domain))) {
          const reason = isSharedHost(domain) ? 'shared host' : 'blocked host';
          if (!dropped.has(domain)) {
            dropped.set(domain, blank({ kind: 'web', domain, name: hit.title || domain, url: hit.link, status: 'dropped', reason }));
          }
          note(dropped.get(domain)!, query.q, hit.title, hit.snippet, query.personaId);
          continue;
        }
        let c = byDomain.get(domain);
        if (!c) {
          c = blank({ kind: 'web', domain, name: hit.title || domain, url: hit.link });
          byDomain.set(domain, c);
        }
        note(c, query.q, hit.title, hit.snippet, query.personaId);
      }
    } else {
      const result = await placesSearch(params);
      result.fromCache ? (cacheHits += 1) : (serperCalls += 1);
      for (const hit of result.hits) {
        hits += 1;
        places.push({ q: query.q, personaId: query.personaId, hit });
      }
    }
  }

  // Maps listings after every web hit is in, so a listing joins the website
  // it names whichever query found which.
  for (const { q, personaId, hit } of places) {
    const site = hit.website ? normalizeDomain(hit.website) : null;
    const snippet = [hit.category, hit.address].filter(Boolean).join(' — ');

    // A listing whose own website is blocked is the blocked company: drop it.
    // One whose "website" is a shared host (an Instagram page) keeps its Maps id.
    if (site && !isSharedHost(site) && (await blocked(site))) {
      if (!dropped.has(site)) {
        dropped.set(site, blank({ kind: 'maps', domain: site, name: hit.title, url: hit.website, status: 'dropped', reason: 'blocked host' }));
      }
      note(dropped.get(site)!, q, hit.title, snippet, personaId);
      continue;
    }
    const domain = site && !isSharedHost(site) ? site : null;

    // The candidate already holding this Maps id wins, so one id is never on
    // two candidates; otherwise the website's candidate takes the listing.
    const owner = hit.cid ? byPlace.get(hit.cid) : undefined;
    let c = owner ?? (domain ? byDomain.get(domain) : undefined);
    if (c) {
      if (c.kind === 'web') c.kind = 'both';
      if (!c.gmaps && hit.cid && !owner) c.gmaps = hit.cid;
      c.placeId ??= hit.placeId;
      c.phone ??= hit.phoneNumber;
      c.address ??= hit.address;
      c.category ??= hit.category;
      if (!c.domain && domain && !byDomain.has(domain)) {
        c.domain = domain;
        byDomain.set(domain, c);
      }
    } else {
      if (!hit.cid && !domain) continue;
      c = blank({
        kind: 'maps',
        domain,
        gmaps: hit.cid,
        placeId: hit.placeId,
        name: hit.title,
        url: hit.website,
        phone: hit.phoneNumber,
        address: hit.address,
        category: hit.category,
      });
      if (domain) byDomain.set(domain, c);
    }
    if (hit.cid && c.gmaps === hit.cid) byPlace.set(hit.cid, c);
    note(c, q, hit.title, snippet, personaId);
  }

  const found = [...new Set([...byDomain.values(), ...byPlace.values()])];
  const all = [...found, ...dropped.values()];

  await withTenant(job.tenant_id, async (tx) => {
    await tx`delete from discovery_candidates where task_id = ${task.id}`;
    for (const c of all) {
      // Matched to the pool by strong identifiers only: a phone is shared too
      // easily to say which company a listing is.
      const company =
        (c.domain ? await findByIdentifier(tx, 'domain', c.domain) : undefined) ??
        (c.gmaps ? await findByIdentifier(tx, 'gmaps', c.gmaps) : undefined) ??
        (c.placeId ? await findByIdentifier(tx, 'gmaps', c.placeId) : undefined);
      if (!company && c.phone && c.status === 'new') {
        const [phone] = normalizeIdentifiers([{ type: 'phone', value: c.phone }], { defaultCountry: task.country }).identifiers;
        const byPhone = phone ? await findByIdentifier(tx, 'phone', phone.value) : undefined;
        if (byPhone) c.reason = `phone matches ${byPhone.name}`.slice(0, MAX_REASON);
      }
      await tx`
        insert into discovery_candidates
          (tenant_id, job_id, task_id, kind, domain, gmaps, name, url, phone, address, category,
           snippets, persona_ids, company_id, status, reason)
        values (${job.tenant_id}, ${job.id}, ${task.id}, ${c.kind}, ${c.domain}, ${c.gmaps},
                ${c.name.slice(0, 300)}, ${c.url}, ${c.phone}, ${c.address}, ${c.category},
                ${tx.json(c.snippets as never)}, ${[...c.personaIds]}::uuid[], ${company?.id ?? null},
                ${c.status}, ${c.reason})
      `;
    }
  });

  return {
    queries: queries.length,
    queries_capped: planned.length - queries.length,
    serper_calls: serperCalls,
    cache_hits: cacheHits,
    hits,
    candidates: found.length,
    dropped_shared: [...dropped.values()].filter((c) => c.reason === 'shared host').length,
    dropped_blocked: [...dropped.values()].filter((c) => c.reason === 'blocked host').length,
  };
}

type CandidateRow = {
  id: string;
  name: string;
  domain: string | null;
  url: string | null;
  snippets: unknown;
  address: string | null;
  category: string | null;
  company_id: string | null;
};

export async function runTriage(job: JobRow, task: TaskRow): Promise<Counts> {
  const personas = await personasOf(job);
  const personaIds = new Set(personas.map((p) => p.id));
  const pending = await withTenant(job.tenant_id, (tx) => tx<CandidateRow[]>`
    select id::text, name, domain, url, snippets, address, category, company_id::text
    from discovery_candidates
    where task_id = ${task.id} and status = 'new'
    order by created_at, id
  `);

  // What the pool already says about a matched company, as data for Claude.
  const companyIds = [...new Set(pending.map((c) => c.company_id).filter((id): id is string => !!id))];
  const profiles = new Map<string, unknown>();
  if (companyIds.length) {
    const rows = await db()<{ company_id: string; products: string[]; roles: string[]; cities: string[] }[]>`
      select company_id::text, products, roles, cities from company_profiles
      where company_id = any(${companyIds}::uuid[])
    `;
    for (const r of rows) profiles.set(r.company_id, { products: r.products, roles: r.roles, cities: r.cities });
  }

  for (let i = 0; i < pending.length; i += TRIAGE_BATCH) {
    const batch = pending.slice(i, i + TRIAGE_BATCH);
    const ids = new Set(batch.map((c) => c.id));
    const input = JSON.stringify({
      side: job.side,
      country: task.country,
      product: job.identified
        ? { name: job.identified.name, category: job.identified.category, description: job.identified.description, uses: job.identified.uses }
        : { name: job.product },
      personas: personas.map((p) => ({ id: p.id, name: p.name, description: p.description, signals: p.signals })),
      candidates: batch.map((c) => ({
        id: c.id,
        name: c.name,
        website: c.domain,
        snippets: c.snippets,
        address: c.address,
        category: c.category,
        profile: c.company_id ? (profiles.get(c.company_id) ?? null) : null,
      })),
    });

    let verdicts: Verdict[] | null = null;
    for (let attempt = 0; attempt < 2 && !verdicts; attempt += 1) {
      // Counted on the task as it happens, so a deferral loses no calls.
      await withTenant(job.tenant_id, (tx) => tx`
        update discovery_tasks
        set counts = counts || jsonb_build_object('claude_calls', coalesce((counts->>'claude_calls')::int, 0) + 1)
        where id = ${task.id}
      `);
      try {
        const parsed = Triage.safeParse(
          await ask('triage', { system: triagePrompt.system, schema: triagePrompt.schema, input }),
        );
        if (parsed.success && answersEvery(parsed.data.verdicts, ids, personaIds)) verdicts = parsed.data.verdicts;
      } catch (err) {
        if (err instanceof UsageLimitError || err instanceof PermanentError) throw err;
      }
    }
    if (!verdicts) continue;

    await withTenant(job.tenant_id, async (tx) => {
      for (const v of verdicts) {
        const keep = v.verdict === 'keep';
        await tx`
          update discovery_candidates set
            status = ${keep ? 'kept' : 'dropped'},
            fit = ${keep ? (v.fit ?? 'weak') : null},
            persona_ids = case when ${keep && v.personaIds.length > 0}
                               then ${v.personaIds}::uuid[] else persona_ids end,
            reason = case when reason like 'phone matches %'
                          then left(${v.reason.trim().slice(0, MAX_REASON)} || ' · ' || reason, 240)
                          else ${v.reason.trim().slice(0, MAX_REASON)} end
          where id = ${v.id} and task_id = ${task.id} and status = 'new'
        `;
      }
    });
  }

  // From the table, so a stage resumed after a deferral still counts every
  // batch: search drops (shared or blocked hosts) are not triage's.
  const [tally] = await withTenant(job.tenant_id, (tx) => tx<{ kept: number; dropped: number; failed: number }[]>`
    select count(*) filter (where status = 'kept')::int as kept,
           count(*) filter (where status = 'dropped' and coalesce(reason, '') not in ('shared host', 'blocked host'))::int as dropped,
           count(*) filter (where status = 'new')::int as failed
    from discovery_candidates where task_id = ${task.id}
  `);
  return { kept: tally?.kept ?? 0, dropped: tally?.dropped ?? 0, triage_failed: tally?.failed ?? 0 };
}

/** Exactly one verdict per candidate sent, and only the job's own personas. */
function answersEvery(verdicts: Verdict[], ids: Set<string>, personaIds: Set<string>): boolean {
  if (verdicts.length !== ids.size) return false;
  const seen = new Set<string>();
  for (const v of verdicts) {
    if (!ids.has(v.id) || seen.has(v.id)) return false;
    seen.add(v.id);
    if (v.personaIds.some((p) => !personaIds.has(p))) return false;
  }
  return true;
}
