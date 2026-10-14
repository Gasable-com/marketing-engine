import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { resetEnv } from '../src/env.js';
import { runTask } from '../src/modules/discovery/index.js';
import { countryPrompt, extractPrompt, identifyPrompt, personasPrompt, triagePrompt } from '../src/modules/discovery/prompts.js';
import { saveMadeSettings } from '../src/modules/discovery/search/country.js';
import { createTenantRule } from '../src/spine/rules/index.js';
import { setCompanyLookup, upsert } from '../src/spine/registry/index.js';
import {
  FakeBridge,
  FakeSerper,
  clearProviders,
  drive,
  ok,
  queued,
  setProviders,
  terms,
} from './fake-bridge.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb } from './helpers.js';

const app = createApp();
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN!;

const DIESEL = {
  name: 'Diesel fuel',
  nameAr: 'ديزل',
  brand: null,
  model: null,
  category: 'Fuels',
  aliases: ['diesel', 'ديزل'],
  description: 'Diesel fuel for engines and generators.',
  uses: ['generators', 'trucks'],
  notIdentified: false,
};

const DIESEL_PERSONAS = {
  personas: [
    {
      name: 'Diesel distributors',
      description: 'Sell diesel in bulk.',
      roles: ['distributor'],
      sectors: ['fuel'],
      searchTerms: terms('diesel fuel supplier', 'توريد ديزل'),
      placesTerms: terms('diesel supplier'),
      signals: ['bulk diesel delivery'],
    },
    {
      name: 'Fuel wholesalers',
      description: 'Wholesale fuel.',
      roles: ['wholesaler'],
      sectors: ['fuel'],
      searchTerms: terms('fuel wholesaler'),
      placesTerms: terms(),
      signals: ['wholesale fuel'],
    },
  ],
};

const MICROSILICA = { ...DIESEL, name: 'Microsilica', nameAr: 'مايكروسيليكا', aliases: ['microsilica'] };
const READY_MIX = {
  personas: [
    {
      name: 'Ready-mix concrete plants',
      description: 'Add it to high-strength mixes.',
      roles: ['manufacturer'],
      sectors: ['construction'],
      searchTerms: terms('ready mix concrete company'),
      placesTerms: terms(),
      signals: ['high strength concrete'],
    },
  ],
};

const bridge = new FakeBridge();
const serper = new FakeSerper([
  { path: '/search', match: /^diesel fuel supplier/, fixture: 'web-diesel-supplier.json' },
  { path: '/search', match: /^توريد ديزل/, fixture: 'web-diesel-ar.json' },
  { path: '/places', match: /^diesel supplier/, fixture: 'places-diesel.json' },
  { path: '/search', match: /^ready mix concrete company/, fixture: 'web-ready-mix.json' },
]);

/** Triage like a careful reader would: news and shops are not suppliers. */
function triage(input: Record<string, unknown>) {
  const personas = input['personas'] as { id: string }[];
  const candidates = input['candidates'] as { id: string; name: string; snippets: { title: string }[] }[];
  return {
    verdicts: candidates.map((c) => {
      const text = `${c.name} ${c.snippets.map((s) => s.title).join(' ')}`.toLowerCase();
      const news = /news|grows|prices rise/.test(text);
      return news
        ? { id: c.id, verdict: 'drop', fit: null, personaIds: [], reason: 'news article' }
        : { id: c.id, verdict: 'keep', fit: /diesel|readymix/.test(text) ? 'strong' : 'weak', personaIds: [personas[0]!.id], reason: 'looks like a supplier' };
    }),
  };
}

/** Claude's description of a country no row describes yet, by code. */
const COUNTRIES: Record<string, unknown> = {
  EG: {
    languages: ['ar'],
    suffix: [{ lang: 'ar', name: 'مصر' }, { lang: 'en', name: 'Egypt' }],
    names: ['arab republic of egypt', 'جمهورية مصر العربية'],
    cities: [
      { names: [{ lang: 'ar', name: 'القاهرة' }, { lang: 'en', name: 'Cairo' }] },
      { names: [{ lang: 'ar', name: 'الإسكندرية' }, { lang: 'en', name: 'Alexandria' }, { lang: 'fr', name: 'Alexandrie' }] },
    ],
    timezone: 'Africa/Cairo',
  },
  TR: {
    languages: ['tr', 'en'],
    suffix: [{ lang: 'tr', name: 'Türkiye' }, { lang: 'en', name: 'Turkey' }],
    names: ['turkey', 'türkiye cumhuriyeti'],
    cities: [
      { names: [{ lang: 'tr', name: 'İstanbul' }, { lang: 'en', name: 'Istanbul' }] },
      { names: [{ lang: 'tr', name: 'Ankara' }, { lang: 'en', name: 'Ankara' }] },
    ],
    timezone: 'Not/A_Zone',
  },
};

function plan(identified: unknown, personas: unknown) {
  bridge.handler = (task, input) => {
    if (task === 'identify') return ok(identified);
    if (task === 'country') return ok(COUNTRIES[String(input['country'])]);
    if (task === 'personas') return ok(personas);
    if (task === 'triage') return ok(triage(input));
    return { status: 400, body: {} };
  };
}

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://engine.test${path}`, {
      method,
      headers: { 'X-Internal-Token': INTERNAL_TOKEN, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, body: (await res.json()) as T };
}

type Candidate = {
  id: string;
  country: string;
  kind: string;
  domain: string | null;
  gmaps: string | null;
  name: string;
  phone: string | null;
  fit: string | null;
  status: string;
  reason: string | null;
  companyId: string | null;
  personas: { id: string; name: string }[];
};

async function search(body: Record<string, unknown>) {
  const created = await call<{ job: { id: string } }>('POST', '/internal/discovery/jobs', {
    tenantId: TENANT_A,
    countries: ['SA'],
    ...body,
  });
  expect(created.status).toBe(201);
  await drive();
  const jobId = created.body.job.id;
  const detail = await call<{
    job: Record<string, unknown> & { spend: Spend };
    tasks: { country: string; status: string; error: string | null; counts: Record<string, number>; spend: Spend }[];
  }>(
    'GET',
    `/internal/discovery/jobs/${jobId}`,
  );
  const candidates = await call<{ items: Candidate[] }>('GET', `/internal/discovery/jobs/${jobId}/candidates`);
  return { jobId, detail: detail.body, candidates: candidates.body.items };
}

const byDomain = (list: Candidate[], domain: string) => list.find((c) => c.domain === domain);

type Spend = { queries: number; serperCalls: number; cacheHits: number; credits: number; usd: number };
type Average = { credits: number; usd: number } | null;
type Totals = Spend & { searches: number; cacheRate: number | null; perSearch: Average; perQuery: Average; perCall: Average };
type Query = {
  id: string;
  at: string;
  tenantName: string;
  jobId: string;
  product: string;
  taskId: string;
  country: string;
  persona: string | null;
  kind: string;
  q: string;
  gl: string;
  hl: string;
  cached: boolean;
  credits: number;
  usd: number;
  hits: number;
};
type Serper = {
  usdPerCredit: number;
  window: Totals;
  allTime: Totals;
  byKind: ({ kind: string } & Spend)[];
  byCountry: ({ country: string } & Spend)[];
  byTenant: ({ tenantId: string; tenantName: string } & Spend)[];
  topSearches: ({ jobId: string; product: string; side: string; countries: string[]; tenantName: string } & Spend)[];
  series: { bucket: string; points: ({ at: string } & Spend)[] };
};

const queryLog = async (params: string) =>
  (await call<{ items: Query[] }>('GET', `/internal/discovery/queries?${params}`)).body.items;

/** The Arabic fixture answers with 2 credits, every other one with 1. */
const charged = () => serper.calls.reduce((n, c) => n + (/^توريد ديزل/.test(c.q) ? 2 : 1), 0);

beforeAll(async () => {
  await bridge.start();
  await resetDb();
  await startQueue();
});

afterAll(async () => {
  clearProviders();
  setCompanyLookup(undefined);
  await bridge.stop();
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  await db()`truncate search_queries`;
  setCompanyLookup(null);
  bridge.calls = [];
  serper.calls = [];
  serper.override = null;
  clearProviders();
  // These tests stop at triage: reading is step 20's, tested on its own.
  process.env.DISCOVERY_MAX_READS = '0';
  setProviders({ bridge: bridge.url(), serper: true });
  serper.install();
  plan(DIESEL, DIESEL_PERSONAS);
});

describe('search', () => {
  it('finds a suppliers task’s candidates, grouped by company, with the noise dropped', async () => {
    const { detail, candidates } = await search({ product: 'diesel', side: 'suppliers' });

    // A Maps listing joins the website it names; a listing with no site of its own stays one.
    expect(byDomain(candidates, 'alfa-diesel.com.sa')).toMatchObject({
      kind: 'both',
      gmaps: '1110000000000000001',
      phone: '050 111 1111',
      status: 'kept',
      fit: 'strong',
      personas: [{ name: 'Diesel distributors' }],
    });
    expect(byDomain(candidates, 'gulf-fuel.com')).toMatchObject({ kind: 'web', status: 'kept' });
    expect(byDomain(candidates, 'najm-fuel.com')).toMatchObject({ kind: 'web', status: 'kept' });
    expect(candidates.find((c) => c.gmaps === '2220000000000000002')).toMatchObject({
      kind: 'maps',
      domain: null,
      name: 'Riyadh Diesel Station',
      status: 'kept',
    });
    // A listing whose website is an Instagram page keeps its Maps id, not the shared host.
    expect(candidates.find((c) => c.gmaps === '3330000000000000003')).toMatchObject({ kind: 'maps', domain: null });

    expect(byDomain(candidates, 'salla.sa')).toMatchObject({ status: 'dropped', reason: 'shared host' });
    expect(byDomain(candidates, 'yellowpages.com.sa')).toMatchObject({ status: 'dropped', reason: 'blocked host' });
    expect(byDomain(candidates, 'arabnews.com')).toMatchObject({ status: 'dropped', reason: 'blocked host' });
    // Kept first in the list.
    expect(candidates.slice(0, 6).every((c) => c.status === 'kept')).toBe(true);

    const counts = detail.tasks[0]!.counts;
    expect(counts).toMatchObject({ candidates: 6, kept: 6, dropped: 0, dropped_shared: 1, dropped_blocked: 2, triage_failed: 0 });

    // A listing with a website of its own that no web hit reached is still a Maps find.
    expect(byDomain(candidates, 'desertfuel.sa')).toMatchObject({ kind: 'maps', gmaps: '5550000000000000005' });
    // A listing whose website is blocked is dropped with it, never kept as Maps-only.
    expect(candidates.find((c) => c.gmaps === '4440000000000000004')).toBeUndefined();
    // One Maps id is on one candidate only, even when a listing names another site.
    expect(candidates.filter((c) => c.gmaps === '1110000000000000001')).toHaveLength(1);
    expect(byDomain(candidates, 'gulf-fuel.com')!.gmaps).toBeNull();
    expect(counts['serper_calls']).toBe(counts['queries']);
    expect(counts['cache_hits']).toBe(0);
    expect(detail.tasks[0]!.status).toBe('done');

    // Triage is told which country it is sorting for.
    expect(bridge.calls.find((c) => c.task === 'triage')!.input).toMatchObject({ country: 'SA', side: 'suppliers' });

    // Arabic terms are searched in Arabic, with the Arabic suffix and cities.
    expect(serper.calls).toContainEqual({ path: '/search', q: 'توريد ديزل السعودية', gl: 'sa', hl: 'ar' });
    expect(serper.calls).toContainEqual({ path: '/places', q: 'diesel supplier Riyadh', gl: 'sa', hl: 'en' });
  });

  it('keeps the ready-mix plants for a buyers task and drops the news', async () => {
    plan(MICROSILICA, READY_MIX);
    const { candidates } = await search({ product: 'Microsilica MS900D  1 MT', side: 'buyers' });
    expect(byDomain(candidates, 'binareadymix.com')).toMatchObject({ status: 'kept', fit: 'strong' });
    expect(byDomain(candidates, 'constructionweekonline.com')).toMatchObject({ status: 'dropped', reason: 'news article' });
  });

  it('answers a repeated search from the cache and replaces the candidates', async () => {
    const first = await search({ product: 'diesel', side: 'suppliers' });
    const callsAfterFirst = serper.calls.length;
    const second = await search({ product: 'diesel', side: 'suppliers' });

    expect(serper.calls.length).toBe(callsAfterFirst);
    expect(second.detail.tasks[0]!.counts).toMatchObject({ serper_calls: 0 });
    expect(second.detail.tasks[0]!.counts['cache_hits']).toBe(first.detail.tasks[0]!.counts['queries']);

    // A task searched again replaces its own candidates rather than adding to them.
    const [task] = await db()<{ id: string }[]>`select id from discovery_tasks where job_id = ${second.jobId}`;
    await db()`update discovery_tasks set status = 'queued', stages_done = '{}' where id = ${task!.id}`;
    await runTask({ tenantId: TENANT_A, taskId: task!.id });
    const [row] = await db()<{ n: number }[]>`select count(*)::int as n from discovery_candidates where task_id = ${task!.id}`;
    expect(row!.n).toBe(second.candidates.length);
  });

  it('fails a task at once when the key is out of credits, and retries a rate limit', async () => {
    serper.override = () => new Response(JSON.stringify({ message: 'Not enough credits' }), { status: 400 });
    const { detail } = await search({ product: 'diesel', side: 'suppliers' });
    expect(detail.tasks[0]).toMatchObject({ status: 'failed', error: 'search provider refused: Not enough credits' });
    expect(serper.calls).toHaveLength(1);

    serper.override = () => new Response(JSON.stringify({ message: 'Too many requests' }), { status: 429 });
    serper.calls = [];
    const created = await call<{ job: { id: string } }>('POST', '/internal/discovery/jobs', {
      tenantId: TENANT_A, countries: ['SA'], product: 'diesel', side: 'suppliers',
    });
    await drive({ finalAttempt: false }).catch(() => undefined);
    const [plan] = await queued('discovery.plan');
    expect(plan).toBeUndefined();
    const [task] = await db()<{ status: string; error: string | null }[]>`
      select status, error from discovery_tasks where job_id = ${created.body.job.id}
    `;
    // Retryable: handed back to the queue, not failed.
    expect(task).toEqual({ status: 'queued', error: null });
  });

  it('caps queries per task and per job, with the personas taking turns', async () => {
    process.env.DISCOVERY_MAX_QUERIES = '3';
    setProviders({ bridge: bridge.url(), serper: true });
    const { detail } = await search({ product: 'diesel', side: 'suppliers' });
    expect(detail.tasks[0]!.counts).toMatchObject({ queries: 3 });
    expect(detail.tasks[0]!.counts['queries_capped']).toBeGreaterThan(0);
    // Persona 1's first web query, persona 2's, then persona 1's first Maps query:
    // personas take turns, and web and Maps alternate within each.
    expect(serper.calls.map((c) => [c.path, c.q])).toEqual([
      ['/search', 'diesel fuel supplier'],
      ['/search', 'fuel wholesaler'],
      ['/places', 'diesel supplier'],
    ]);

    delete process.env.DISCOVERY_MAX_QUERIES;
    process.env.DISCOVERY_MAX_QUERIES_PER_JOB = '4';
    setProviders({ bridge: bridge.url(), serper: true });
    const two = await search({ product: 'diesel', side: 'suppliers', countries: ['SA', 'AE'] });
    expect(two.detail.tasks.map((t) => t.counts['queries'])).toEqual([2, 2]);
  });

  it('searches the UAE with its own settings, and honours a tenant’s blocked host', async () => {
    await withTenant(TENANT_A, (tx) =>
      createTenantRule(tx, {
        tenantId: TENANT_A,
        kind: 'discovery.blocked_hosts',
        name: 'not gulf fuel',
        document: { in: [{ var: 'host' }, ['gulf-fuel.com']] },
      }),
    );
    const { candidates } = await search({ product: 'diesel', side: 'suppliers', countries: ['AE'] });
    expect(serper.calls).toContainEqual({ path: '/search', q: 'diesel fuel supplier UAE', gl: 'ae', hl: 'en' });
    expect(serper.calls).toContainEqual({ path: '/places', q: 'diesel supplier Dubai', gl: 'ae', hl: 'en' });
    expect(byDomain(candidates, 'gulf-fuel.com')).toMatchObject({ status: 'dropped', reason: 'blocked host' });
    // The platform's list still applies under the tenant's own.
    expect(byDomain(candidates, 'yellowpages.com.sa')).toMatchObject({ status: 'dropped', reason: 'blocked host' });
  });

  it('asks again once when triage leaves a candidate out, then gives up on the batch', async () => {
    bridge.handler = (task, input, n) => {
      if (task === 'identify') return ok(DIESEL);
      if (task === 'personas') return ok(DIESEL_PERSONAS);
      const full = triage(input);
      return ok(n === 1 ? { verdicts: full.verdicts.slice(1) } : full);
    };
    const first = await search({ product: 'diesel', side: 'suppliers' });
    expect(first.detail.tasks[0]!.counts).toMatchObject({ claude_calls: 2, kept: 6, triage_failed: 0 });

    bridge.calls = [];
    bridge.handler = (task, input) => {
      if (task === 'identify') return ok(DIESEL);
      if (task === 'personas') return ok(DIESEL_PERSONAS);
      return ok({ verdicts: triage(input).verdicts.map((v) => ({ ...v, personaIds: ['00000000-0000-0000-0000-000000000000'] })) });
    };
    const second = await search({ product: 'diesel', side: 'suppliers' });
    expect(second.detail.tasks[0]).toMatchObject({ status: 'done' });
    expect(second.detail.tasks[0]!.counts).toMatchObject({ claude_calls: 2, kept: 0, triage_failed: 6 });
    expect(second.candidates.filter((c) => c.status === 'new')).toHaveLength(6);
  });

  it('matches candidates to the pool by domain, never by phone', async () => {
    const byDomainCompany = await withTenant(TENANT_A, (tx) =>
      upsert(tx, { name: 'Gulf Fuel', identifiers: [{ type: 'domain', value: 'gulf-fuel.com' }], source: { type: 'api', tenantId: TENANT_A } }),
    );
    await withTenant(TENANT_A, (tx) =>
      upsert(tx, { name: 'Somebody Else', identifiers: [{ type: 'phone', value: '+966552222222' }], source: { type: 'api', tenantId: TENANT_A } }),
    );
    const { candidates } = await search({ product: 'diesel', side: 'suppliers' });
    expect(byDomain(candidates, 'gulf-fuel.com')!.companyId).toBe(byDomainCompany.company.id);
    const byPhone = candidates.find((c) => c.gmaps === '2220000000000000002')!;
    expect(byPhone.companyId).toBeNull();
    // The phone is only noted, after triage's own reason.
    expect(byPhone.reason).toBe('looks like a supplier · phone matches Somebody Else');
  });

  it('counts every triage call and verdict across a usage-limit deferral', async () => {
    bridge.handler = (task, input, n) => {
      if (task === 'identify') return ok(DIESEL);
      if (task === 'personas') return ok(DIESEL_PERSONAS);
      return n === 1 ? { status: 429, body: { error: 'usage_limit', resetsAt: null } } : ok(triage(input));
    };
    const { detail } = await search({ product: 'diesel', side: 'suppliers' });
    expect(detail.tasks[0]).toMatchObject({ status: 'done' });
    expect(detail.tasks[0]!.counts).toMatchObject({ kept: 6, triage_failed: 0, claude_calls: 2 });
  });

  it('makes a new country’s settings once, saves them as its row, and searches it in its own languages and cities', async () => {
    plan(DIESEL, {
      personas: [
        { ...DIESEL_PERSONAS.personas[0]!, searchTerms: terms('diesel fuel supplier', 'diesel supplier Dubai', 'diesel makkah', 'توريد ديزل') },
      ],
    });
    const { jobId } = await search({ product: 'diesel', side: 'suppliers', countries: ['EG'] });

    expect(bridge.calls.filter((c) => c.task === 'country').map((c) => c.input)).toEqual([{ country: 'EG', name: 'Egypt' }]);
    expect(bridge.calls.find((c) => c.task === 'personas')!.input).toMatchObject({
      countries: [{ code: 'EG', name: 'Egypt' }],
      languages: ['ar', 'en'],
    });
    const [row] = await db()<{ scope: string; name: string; document: unknown }[]>`
      select scope, name, document from rules where kind = 'discovery.country' and region = 'EG'
    `;
    expect(row).toEqual({
      scope: 'region',
      name: 'Search Egypt (made by Claude)',
      document: {
        if: [
          true,
          {
            gl: 'eg',
            languages: ['ar', 'en'],
            suffix: { ar: 'مصر', en: 'Egypt' },
            names: ['arab republic of egypt', 'جمهورية مصر العربية', 'مصر', 'Egypt'],
            // A name in a language Egypt is not searched in is dropped.
            cities: [{ ar: 'القاهرة', en: 'Cairo' }, { ar: 'الإسكندرية', en: 'Alexandria' }],
          },
          null,
        ],
      },
    });

    // Egypt is now a region, in its own zone; a made-up zone falls back to UTC.
    const zones = await db()`select code, timezone from regions where code in ('EG', 'TR') order by code`;
    expect(zones).toEqual([{ code: 'EG', timezone: 'Africa/Cairo' }]);

    // Arabic as well as English, each with Egypt's name and cities in its own script.
    expect(serper.calls).toContainEqual({ path: '/search', q: 'توريد ديزل', gl: 'eg', hl: 'ar' });
    expect(serper.calls).toContainEqual({ path: '/search', q: 'توريد ديزل مصر', gl: 'eg', hl: 'ar' });
    expect(serper.calls).toContainEqual({ path: '/search', q: 'diesel fuel supplier Egypt', gl: 'eg', hl: 'en' });
    expect(serper.calls).toContainEqual({ path: '/places', q: 'diesel supplier Cairo', gl: 'eg', hl: 'en' });
    // Every country's place names are cleaned from the terms, the seeded ones too.
    const [persona] = await db()<{ search_terms: string[] }[]>`select search_terms from discovery_personas where job_id = ${jobId}`;
    expect(persona!.search_terms).toEqual(['diesel fuel supplier', 'توريد ديزل']);

    // The next search in Egypt asks nothing.
    bridge.calls = [];
    await search({ product: 'diesel', side: 'suppliers', countries: ['EG'] });
    expect(bridge.count('country')).toBe(0);
    expect(bridge.count('personas')).toBe(1);
  });

  it('searches each term in its own language, and drops a term in a language the country does not use', async () => {
    plan(DIESEL, {
      personas: [
        {
          ...DIESEL_PERSONAS.personas[0]!,
          searchTerms: [
            { term: 'motorin tedarikçisi', lang: 'tr' },
            { term: 'diesel fuel supplier', lang: 'en' },
            { term: 'توريد ديزل', lang: 'ar' },
          ],
          placesTerms: [{ term: 'akaryakıt bayi', lang: 'tr' }],
        },
      ],
    });
    const { jobId } = await search({ product: 'diesel', side: 'suppliers', countries: ['TR'] });
    expect(serper.calls).toContainEqual({ path: '/search', q: 'motorin tedarikçisi', gl: 'tr', hl: 'tr' });
    expect(serper.calls).toContainEqual({ path: '/search', q: 'motorin tedarikçisi Türkiye', gl: 'tr', hl: 'tr' });
    expect(serper.calls).toContainEqual({ path: '/search', q: 'diesel fuel supplier Turkey', gl: 'tr', hl: 'en' });
    expect(serper.calls).toContainEqual({ path: '/places', q: 'akaryakıt bayi İstanbul', gl: 'tr', hl: 'tr' });
    expect(serper.calls.some((c) => c.hl === 'ar')).toBe(false);
    expect(await db()`select timezone from regions where code = 'TR'`).toEqual([{ timezone: 'UTC' }]);
    const [persona] = await db()<{ search_terms: string[]; term_langs: Record<string, string> }[]>`
      select search_terms, term_langs from discovery_personas where job_id = ${jobId}
    `;
    expect(persona).toEqual({
      search_terms: ['motorin tedarikçisi', 'diesel fuel supplier'],
      term_langs: { 'motorin tedarikçisi': 'tr', 'diesel fuel supplier': 'en', 'akaryakıt bayi': 'tr' },
    });
  });

  it('lets the operator list every country and correct one, and the next search uses the correction', async () => {
    await search({ product: 'diesel', side: 'suppliers', countries: ['EG'] });
    const list = await call<{ items: { code: string; name: string; rule: string; settings: Record<string, unknown> }[] }>(
      'GET',
      '/internal/discovery/countries',
    );
    expect(list.body.items.map((i) => [i.code, i.name, i.rule])).toEqual([
      ['AE', 'United Arab Emirates', 'Search the UAE'],
      ['EG', 'Egypt', 'Search Egypt (made by Claude)'],
      ['SA', 'Saudi Arabia', 'Search Saudi Arabia'],
    ]);
    const egypt = list.body.items.find((i) => i.code === 'EG')!.settings;

    const wrongLanguage = await call('POST', '/internal/discovery/countries/EG', { settings: { ...egypt, suffix: { fr: 'Égypte' } } });
    expect(wrongLanguage.status).toBe(400);
    expect((await call('POST', '/internal/discovery/countries/XX', { settings: egypt })).status).toBe(400);

    const saved = await call<{ country: { rule: string } }>('POST', '/internal/discovery/countries/EG', {
      settings: { ...egypt, cities: [{ en: 'Port Said', ar: 'بورسعيد' }] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.country.rule).toBe('Search Egypt (set by operator)');

    bridge.calls = [];
    serper.calls = [];
    await search({ product: 'diesel', side: 'suppliers', countries: ['EG'] });
    expect(bridge.count('country')).toBe(0);
    expect(serper.calls).toContainEqual({ path: '/places', q: 'diesel supplier Port Said', gl: 'eg', hl: 'en' });
    expect(serper.calls.some((c) => c.q.includes('Cairo'))).toBe(false);
  });

  it('writes one row when two jobs make the same country’s settings at once', async () => {
    const settings = { gl: 'ke', languages: ['en', 'sw'], suffix: { en: 'Kenya' }, names: ['kenya'], cities: [{ en: 'Nairobi' }] };
    const saved = await Promise.all([saveMadeSettings(TENANT_A, 'KE', settings), saveMadeSettings(TENANT_B, 'KE', settings)]);
    expect(saved.sort()).toEqual([false, true]);
    expect(await db()`select id from rules where kind = 'discovery.country' and region = 'KE'`).toHaveLength(1);
  });

  it('refuses a country code that does not exist', async () => {
    const res = await call('POST', '/internal/discovery/jobs', { tenantId: TENANT_A, product: 'diesel', countries: ['XX'] });
    expect(res.status).toBe(400);
  });

  it('frames no prompt as Saudi Arabia or the Gulf', () => {
    for (const prompt of [identifyPrompt, countryPrompt, personasPrompt, triagePrompt, extractPrompt]) {
      expect(prompt.system).not.toMatch(/saudi|gulf/i);
    }
  });

  it('makes no Serper call without the bridge, and ranks as before', async () => {
    setProviders({ bridge: null, serper: true });
    const { detail, candidates } = await search({ product: 'diesel', side: 'suppliers' });
    expect(serper.calls).toHaveLength(0);
    expect(candidates).toHaveLength(0);
    expect(detail.tasks[0]).toMatchObject({ status: 'done', counts: { ranked: 0 } });
  });

  it('keeps candidates to their tenant and shares the cache', async () => {
    const { jobId } = await search({ product: 'diesel', side: 'suppliers' });
    const seen = (tenantId: string) =>
      withTenant(tenantId, (tx) => tx`select id from discovery_candidates where job_id = ${jobId}`);
    expect((await seen(TENANT_A)).length).toBeGreaterThan(0);
    expect(await seen(TENANT_B)).toHaveLength(0);
    const cache = await withTenant(TENANT_B, (tx) => tx`select id from search_queries`);
    expect(cache.length).toBeGreaterThan(0);
  });
});

describe('cost', () => {
  it('records every query with the credits Serper charged, and prices them', async () => {
    const { jobId, detail } = await search({ product: 'diesel', side: 'suppliers' });
    const counts = detail.tasks[0]!.counts;
    const credits = charged();
    expect(credits).toBeGreaterThan(counts['serper_calls']!);
    expect(counts['serper_credits']).toBe(credits);

    const log = await queryLog(`jobId=${jobId}`);
    expect(log).toHaveLength(counts['queries']!);
    expect(log.every((q) => !q.cached)).toBe(true);
    expect(log.reduce((n, q) => n + q.credits, 0)).toBe(credits);
    expect(log.find((q) => q.q === 'توريد ديزل')).toMatchObject({
      kind: 'web',
      gl: 'sa',
      hl: 'ar',
      country: 'SA',
      credits: 2,
      usd: 0.002,
      hits: 2,
      persona: 'Diesel distributors',
      product: 'Diesel fuel',
      tenantName: 'Tenant A',
    });
    expect(log.find((q) => q.q === 'diesel supplier Riyadh')).toMatchObject({ kind: 'places', credits: 1, usd: 0.001 });
    // Newest first, like every feed.
    expect([...log].sort((a, b) => Number(b.id) - Number(a.id)).map((q) => q.id)).toEqual(log.map((q) => q.id));

    // The job, its task and the list all carry the same spend, from the same events.
    const spend: Spend = { queries: counts['queries']!, serperCalls: counts['serper_calls']!, cacheHits: 0, credits, usd: credits / 1000 };
    expect(detail.job.spend).toEqual(spend);
    expect(detail.tasks[0]!.spend).toEqual(spend);
    const list = await call<{ items: { id: string; spend: Spend }[] }>('GET', '/internal/discovery/jobs');
    expect(list.body.items.find((j) => j.id === jobId)!.spend).toEqual(spend);

    // The price is configuration, applied when read: halve it and every figure halves.
    process.env.SERPER_USD_PER_CREDIT = '0.0005';
    resetEnv();
    const cheaper = await call<{ job: { spend: Spend } }>('GET', `/internal/discovery/jobs/${jobId}`);
    expect(cheaper.body.job.spend).toEqual({ ...spend, usd: credits / 2000 });
  });

  it('counts a cached answer as a query that cost nothing', async () => {
    const first = await search({ product: 'diesel', side: 'suppliers' });
    const second = await search({ product: 'diesel', side: 'suppliers' });
    const queries = first.detail.job.spend.queries;
    expect(second.detail.job.spend).toEqual({ queries, serperCalls: 0, cacheHits: queries, credits: 0, usd: 0 });

    const log = await queryLog(`jobId=${second.jobId}`);
    expect(log).toHaveLength(queries);
    expect(log.every((q) => q.cached && q.credits === 0 && q.usd === 0)).toBe(true);

    // The filter tells paid from free, and the window applies without a job.
    expect(await queryLog(`jobId=${second.jobId}&cached=false`)).toHaveLength(0);
    expect(await queryLog('cached=true&window=24h')).toHaveLength(queries);
    expect(await queryLog('cached=false&window=24h')).toHaveLength(queries);
  });

  it('keeps the queries a task paid for before it failed', async () => {
    let calls = 0;
    serper.override = () =>
      ++calls === 3 ? new Response(JSON.stringify({ message: 'Not enough credits' }), { status: 400 }) : null;
    const { jobId, detail } = await search({ product: 'diesel', side: 'suppliers' });
    expect(detail.tasks[0]).toMatchObject({ status: 'failed', error: 'search provider refused: Not enough credits' });

    const log = await queryLog(`jobId=${jobId}`);
    expect(log).toHaveLength(2);
    const credits = log[0]!.credits + log[1]!.credits;
    expect(detail.job.spend).toEqual({ queries: 2, serperCalls: 2, cacheHits: 0, credits, usd: credits / 1000 });
    expect(detail.tasks[0]!.spend).toEqual(detail.job.spend);
    // The stage never finished, so the counts never saw it; the log did.
    expect(detail.tasks[0]!.counts['serper_credits']).toBeUndefined();
  });

  it('charges one credit for an answer that does not say', async () => {
    serper.override = (c) =>
      c.path === '/places'
        ? new Response(JSON.stringify({ places: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : null;
    const { jobId } = await search({ product: 'diesel', side: 'suppliers' });
    const log = await queryLog(`jobId=${jobId}&kind=places`);
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((q) => q.credits === 1 && q.usd === 0.001 && q.hits === 0)).toBe(true);
  });

  it('adds the spend up for the overview', async () => {
    const diesel = await search({ product: 'diesel', side: 'suppliers' });
    plan(MICROSILICA, READY_MIX);
    const mix = await search({ product: 'Microsilica MS900D  1 MT', side: 'buyers' });
    const a = diesel.detail.job.spend;
    const b = mix.detail.job.spend;
    const credits = a.credits + b.credits;
    const queries = a.queries + b.queries;

    const view = (await call<{ serper: Serper }>('GET', '/internal/overview?window=24h')).body.serper;
    expect(view.usdPerCredit).toBe(0.001);
    expect(view.window).toMatchObject({
      searches: 2,
      queries,
      serperCalls: a.serperCalls + b.serperCalls,
      cacheHits: 0,
      credits,
      usd: credits / 1000,
      cacheRate: 0,
    });
    expect(view.window.perSearch!.usd).toBeCloseTo(view.window.usd / 2, 6);
    expect(view.window.perSearch!.credits).toBeCloseTo(credits / 2, 2);
    expect(view.window.perQuery!.usd).toBeCloseTo(view.window.usd / queries, 6);
    expect(view.window.perCall!.credits).toBeCloseTo(credits / view.window.serperCalls, 2);
    // Everything happened just now, so all time is this window.
    expect(view.allTime).toEqual(view.window);

    const kinds = Object.fromEntries(view.byKind.map((k) => [k.kind, k.credits]));
    expect(Object.keys(kinds).sort()).toEqual(['places', 'web']);
    expect(kinds['web']! + kinds['places']!).toBe(credits);
    const { searches, cacheRate, perSearch, perQuery, perCall, ...spend } = view.window;
    expect([searches, cacheRate, perSearch, perQuery, perCall].length).toBe(5);
    expect(view.byCountry).toEqual([{ country: 'SA', ...spend }]);
    expect(view.byTenant).toMatchObject([{ tenantId: TENANT_A, tenantName: 'Tenant A', credits }]);

    // The costliest search first, named.
    expect(view.topSearches.map((t) => t.jobId).sort()).toEqual([diesel.jobId, mix.jobId].sort());
    expect(view.topSearches[0]!.credits).toBeGreaterThanOrEqual(view.topSearches[1]!.credits);
    expect(view.topSearches.find((t) => t.jobId === diesel.jobId)).toMatchObject({
      product: 'Diesel fuel',
      side: 'suppliers',
      countries: ['SA'],
      tenantName: 'Tenant A',
      ...a,
    });

    // Hourly over a day, every hour present, adding up to the total.
    expect(view.series.bucket).toBe('hour');
    expect(view.series.points).toHaveLength(25);
    expect(view.series.points.reduce((n, p) => n + p.credits, 0)).toBe(credits);
    expect(view.series.points.reduce((n, p) => n + p.queries, 0)).toBe(queries);

    // A window with nothing in it says so, with no averages invented.
    const empty = (await call<{ serper: Serper }>('GET', '/internal/overview?window=1h&until=2020-01-01T00:00:00Z')).body.serper;
    expect(empty.window).toMatchObject({ searches: 0, queries: 0, credits: 0, usd: 0, cacheRate: null, perSearch: null, perQuery: null, perCall: null });
    expect(empty.allTime.credits).toBe(credits);
    expect(empty.byKind).toEqual([]);
    expect(empty.topSearches).toEqual([]);
    expect(empty.series.points).toHaveLength(2);
  });
});
