import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { runTask } from '../src/modules/discovery/index.js';
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
      searchTerms: ['diesel fuel supplier', 'توريد ديزل'],
      placesTerms: ['diesel supplier'],
      signals: ['bulk diesel delivery'],
    },
    {
      name: 'Fuel wholesalers',
      description: 'Wholesale fuel.',
      roles: ['wholesaler'],
      sectors: ['fuel'],
      searchTerms: ['fuel wholesaler'],
      placesTerms: [],
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
      searchTerms: ['ready mix concrete company'],
      placesTerms: [],
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

function plan(identified: unknown, personas: unknown) {
  bridge.handler = (task, input) => {
    if (task === 'identify') return ok(identified);
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
  const detail = await call<{ job: Record<string, unknown>; tasks: { country: string; status: string; error: string | null; counts: Record<string, number> }[] }>(
    'GET',
    `/internal/discovery/jobs/${jobId}`,
  );
  const candidates = await call<{ items: Candidate[] }>('GET', `/internal/discovery/jobs/${jobId}/candidates`);
  return { jobId, detail: detail.body, candidates: candidates.body.items };
}

const byDomain = (list: Candidate[], domain: string) => list.find((c) => c.domain === domain);

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

  it('searches a country with no row in English only, and cleans every country’s place names from terms', async () => {
    plan(DIESEL, {
      personas: [
        { ...DIESEL_PERSONAS.personas[0]!, searchTerms: ['diesel fuel supplier', 'diesel supplier Dubai', 'diesel makkah', 'توريد ديزل'] },
      ],
    });
    const { jobId } = await search({ product: 'diesel', side: 'suppliers', countries: ['EG'] });
    expect(serper.calls.every((c) => c.hl === 'en' && c.gl === 'eg')).toBe(true);
    const [persona] = await db()<{ search_terms: string[] }[]>`select search_terms from discovery_personas where job_id = ${jobId}`;
    expect(persona!.search_terms).toEqual(['diesel fuel supplier', 'توريد ديزل']);
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
