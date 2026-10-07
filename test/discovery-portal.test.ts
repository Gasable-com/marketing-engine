import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { setProfile } from '../src/modules/discovery/index.js';
import { createTenantRule } from '../src/spine/rules/index.js';
import { setCompanyLookup, upsert } from '../src/spine/registry/index.js';
import { FakeBridge, clearProviders, drive, ok, setProviders } from './fake-bridge.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN!;
let tokenA: string;

const identified = (name: string, aliases: string[]) => ({
  name, nameAr: name, brand: null, model: null, category: 'Fuels', aliases,
  description: `${name}.`, uses: ['generators'], notIdentified: name === 'zzz', confidence: 'certain', alternatives: [],
});
const PERSONAS = {
  personas: [
    { name: 'Distributors', description: 'Sell it.', roles: ['distributor'], sectors: ['fuel'], searchTerms: ['fuel distributor'], placesTerms: ['fuel station'], signals: ['bulk delivery'] },
  ],
};

const bridge = new FakeBridge();

async function v1<T = Record<string, unknown>>(method: string, path: string, body?: unknown, token = tokenA) {
  const res = await app.fetch(
    new Request(`http://engine.test${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, text };
}

async function internal<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://engine.test${path}`, {
      method,
      headers: { 'X-Internal-Token': INTERNAL_TOKEN, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, body: (await res.json()) as T };
}

/** A pool of three companies with contacts the portal must never see. */
async function seedPool() {
  const add = async (name: string, domain: string, phone: string, products: string[], city: string) => {
    const { company } = await withTenant(TENANT_A, (tx) =>
      upsert(tx, {
        name,
        country: 'SA',
        identifiers: [{ type: 'domain', value: domain }, { type: 'phone', value: phone }, { type: 'email', value: `sales@${domain}` }],
        source: { type: 'api', tenantId: TENANT_A },
      }),
    );
    await withTenant(TENANT_A, (tx) =>
      setProfile(tx, { tenantId: TENANT_A, companyId: company.id, products, cities: [city], quality: 'full', profiledAt: new Date() }),
    );
    return company.id;
  };
  return {
    alfa: await add('Alfa Diesel', 'alfa-diesel.com.sa', '+966501111111', ['Diesel fuel supply'], 'Riyadh'),
    gulf: await add('Gulf Fuel', 'gulf-fuel.com', '+966502222222', ['Diesel and fuel oil'], 'Dammam'),
    gas: await add('Riyadh Gas', 'riyadh-gas.com', '+966503333333', ['LPG cylinders'], 'Riyadh'),
  };
}

beforeAll(async () => {
  await bridge.start();
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
});

afterAll(async () => {
  clearProviders();
  setCompanyLookup(undefined);
  await bridge.stop();
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  setCompanyLookup(null);
  bridge.calls = [];
  clearProviders();
  setProviders({ bridge: bridge.url(), serper: false });
  bridge.handler = (task, input) => {
    if (task === 'identify') {
      const product = String(input['product']);
      if (/lpg/i.test(product)) return ok(identified('LPG', ['lpg', 'lpg cylinders']));
      if (/zzz/.test(product)) return ok(identified('zzz', []));
      return ok(identified('Diesel fuel', ['diesel', 'diesel fuel']));
    }
    if (task === 'personas') return ok(PERSONAS);
    return { status: 400, body: {} };
  };
});

describe('a supplier or corporate searching from the portal', () => {
  it('sees only name, city and why: never a phone, email, domain or page', async () => {
    const pool = await seedPool();
    const created = await v1<{ search: Record<string, unknown> }>('POST', '/v1/discovery/searches', {
      requesterRef: 'corp-7',
      productRef: 'cat-101',
      product: 'Diesel fuel',
      side: 'suppliers',
    });
    expect(created.status).toBe(201);
    expect(created.body.search).toMatchObject({
      requesterRef: 'corp-7', productRef: 'cat-101', countries: ['SA'], status: 'planning', progress: 'understanding the product',
    });
    const id = String(created.body.search['id']);
    await drive();

    const answer = await v1<{ search: Record<string, unknown>; results: Record<string, unknown>[] }>(
      'GET',
      `/v1/discovery/searches/${id}/results?requesterRef=corp-7`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.search).toMatchObject({ status: 'done', progress: 'done', identifiedAs: 'Diesel fuel', ranked: 2 });
    // Equal scores: the order between the two is the finder's tie-break.
    expect(answer.body.results.map((r) => (r['company'] as { id: string }).id).sort()).toEqual([pool.alfa, pool.gulf].sort());
    expect(answer.body.results.find((r) => (r['company'] as { id: string }).id === pool.alfa)).toEqual({
      rank: expect.any(Number),
      company: { id: pool.alfa, name: 'Alfa Diesel' },
      city: 'Riyadh',
      country: 'SA',
      persona: null,
      fit: null,
      why: expect.arrayContaining([expect.stringMatching(/^product: /)]),
    });
    for (const leak of ['alfa-diesel.com.sa', '+96650', 'sales@', 'http', 'gmaps']) {
      expect(answer.text).not.toContain(leak);
    }

    // Another requester sees none of it.
    expect((await v1('GET', `/v1/discovery/searches/${id}?requesterRef=corp-8`)).status).toBe(404);
    expect((await v1('GET', `/v1/discovery/searches/${id}/results?requesterRef=corp-8`)).status).toBe(404);
    const list = await v1<{ items: unknown[] }>('GET', '/v1/discovery/searches?requesterRef=corp-8');
    expect(list.body.items).toEqual([]);
    expect((await v1<{ items: unknown[] }>('GET', '/v1/discovery/searches?requesterRef=corp-7')).body.items).toHaveLength(1);
    // Nor does another tenant.
    expect((await v1('GET', `/v1/discovery/searches/${id}?requesterRef=corp-7`, undefined, await tokenFor(TENANT_B))).status).toBe(404);
  });

  it('runs an RFQ as one search, with results split by product, in line order', async () => {
    const pool = await seedPool();
    const created = await v1<{ rfqSearch: { id: string; lines: { lineRef: string; product: string }[] } }>(
      'POST',
      '/v1/discovery/rfq-searches',
      {
        requesterRef: 'corp-7',
        rfqRef: 'RFQ-A',
        lines: [
          { lineRef: 'L1', product: 'Diesel fuel' },
          { lineRef: 'L2', product: 'LPG cylinders' },
          { lineRef: 'L3', product: 'zzz' },
        ],
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.rfqSearch.lines.map((l) => [l.lineRef, l.product])).toEqual([
      ['L1', 'Diesel fuel'],
      ['L2', 'LPG cylinders'],
      ['L3', 'zzz'],
    ]);
    await drive();

    const answer = await v1<{ rfqSearch: Record<string, unknown>; lines: { lineRef: string; status: string; results: { company: { id: string } }[] }[] }>(
      'GET',
      `/v1/discovery/rfq-searches/${created.body.rfqSearch.id}/results?requesterRef=corp-7`,
    );
    expect(answer.body.rfqSearch).toMatchObject({ rfqRef: 'RFQ-A', status: 'done' });
    expect(answer.body.lines.map((l) => [l.lineRef, l.status, l.results.map((r) => r.company.id).sort()])).toEqual([
      ['L1', 'done', [pool.alfa, pool.gulf].sort()],
      ['L2', 'done', [pool.gas]],
      // A line that fails leaves the RFQ done when another line is done.
      ['L3', 'failed', []],
    ]);

    const finished = await db()<{ payload: Record<string, unknown> }[]>`
      select payload from events where type = 'discovery.rfq.finished'
    `;
    expect(finished).toHaveLength(1);
    expect(finished[0]!.payload).toMatchObject({
      rfqRef: 'RFQ-A',
      requesterRef: 'corp-7',
      status: 'done',
      lines: [
        { lineRef: 'L1', status: 'done', ranked: 2 },
        { lineRef: 'L2', status: 'done', ranked: 1 },
        { lineRef: 'L3', status: 'failed', ranked: 0 },
      ],
    });

    // The operator sees it too, line by line.
    const operator = await internal<{ rfqSearch: Record<string, unknown>; lines: Record<string, unknown>[] }>(
      'GET',
      `/internal/discovery/rfq-searches/${created.body.rfqSearch.id}`,
    );
    expect(operator.body.lines.map((l) => l['product'])).toEqual(['Diesel fuel', 'LPG cylinders', 'zzz']);
    expect((await v1('GET', `/v1/discovery/rfq-searches/${created.body.rfqSearch.id}?requesterRef=other`)).status).toBe(404);
  });

  it('holds each requester to 5 searches a day, counting an RFQ as one', async () => {
    for (let i = 0; i < 4; i += 1) {
      expect((await v1('POST', '/v1/discovery/searches', { requesterRef: 'sup-1', product: `Diesel ${i}`, side: 'suppliers' })).status).toBe(201);
    }
    const rfq = await v1('POST', '/v1/discovery/rfq-searches', {
      requesterRef: 'sup-1',
      lines: [{ product: 'Diesel fuel' }, { product: 'LPG cylinders' }],
    });
    expect(rfq.status).toBe(201);

    const quota = await v1<Record<string, { used: number; max: number }>>('GET', '/v1/discovery/quota?requesterRef=sup-1');
    expect(quota.body).toMatchObject({ day: { used: 5, max: 5 }, month: { used: 5, max: 50 } });

    const refused = await v1<Record<string, unknown>>('POST', '/v1/discovery/searches', { requesterRef: 'sup-1', product: 'Diesel 9', side: 'suppliers' });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'quota_exceeded', limit: 'day', used: 5, max: 5 });
    expect(new Date(String(refused.body['resetsAt'])).getTime()).toBeGreaterThan(Date.now());

    // Another requester has their own allowance; the operator has none to spend.
    expect((await v1('POST', '/v1/discovery/searches', { requesterRef: 'sup-2', product: 'Diesel', side: 'suppliers' })).status).toBe(201);
    expect((await internal('POST', '/internal/discovery/jobs', { tenantId: TENANT_A, product: 'Diesel', countries: ['SA'] })).status).toBe(201);

    // A tenant row raises the limit.
    await withTenant(TENANT_A, (tx) =>
      createTenantRule(tx, { tenantId: TENANT_A, kind: 'discovery.quota', name: 'more', document: { if: [true, { day: 10, month: 100 }, null] } }),
    );
    expect((await v1('POST', '/v1/discovery/searches', { requesterRef: 'sup-1', product: 'Diesel 9', side: 'suppliers' })).status).toBe(201);
  });

  it('reuses a catalog product’s identification, and tells the portal’s webhook who and what', async () => {
    await seedPool();
    const first = await v1<{ search: { id: string } }>('POST', '/v1/discovery/searches', { requesterRef: 'sup-3', productRef: 'cat-9', product: 'Diesel fuel', side: 'suppliers' });
    await drive();
    await v1('POST', '/v1/discovery/searches', { requesterRef: 'sup-3', productRef: 'cat-9', product: 'Diesel fuel', side: 'suppliers' });
    await drive();
    expect(bridge.count('identify')).toBe(1);

    const [finished] = await db()<{ payload: Record<string, unknown> }[]>`
      select payload from events where type = 'discovery.job.finished' and subject_id = ${first.body.search.id}
    `;
    expect(finished!.payload).toMatchObject({ requesterRef: 'sup-3', productRef: 'cat-9', rfqSearchId: null });
  });

  it('refuses a search with no requester, and a bad RFQ', async () => {
    expect((await v1('POST', '/v1/discovery/searches', { product: 'Diesel', side: 'suppliers' })).status).toBe(400);
    expect((await v1('POST', '/v1/discovery/rfq-searches', { requesterRef: 'x', lines: [] })).status).toBe(400);
    expect((await v1('GET', '/v1/discovery/searches')).status).toBe(400);
  });
});
