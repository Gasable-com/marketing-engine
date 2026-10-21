import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { setProfile } from '../src/modules/discovery/index.js';
import { createTenantRule } from '../src/spine/rules/index.js';
import { suppress } from '../src/spine/consent/index.js';
import { setCompanyLookup, upsert } from '../src/spine/registry/index.js';
import { FakeBridge, clearProviders, drive, ok, setProviders, terms } from './fake-bridge.js';
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
    { name: 'Distributors', description: 'Sell it.', roles: ['distributor'], sectors: ['fuel'], searchTerms: terms('fuel distributor'), placesTerms: terms('fuel station'), signals: ['bulk delivery'] },
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

/** A pool of three companies, each with a domain, a phone and an email. */
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
  it('sees name, city, why and the company’s contacts: never a page, a Maps id or another requester’s search', async () => {
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
      phones: ['+966501111111'],
      emails: ['sales@alfa-diesel.com.sa'],
      website: 'https://alfa-diesel.com.sa',
    });
    for (const leak of ['http://', 'gmaps', 'www.']) {
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
    // Every line's results carry the companies' contacts.
    const contactsOf = (l: { results: Record<string, unknown>[] }) =>
      l.results
        .map((r) => [(r['company'] as { name: string }).name, r['phones'], r['emails'], r['website']])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(answer.body.lines.map((l) => [l.lineRef, contactsOf(l as never)])).toEqual([
      ['L1', [
        ['Alfa Diesel', ['+966501111111'], ['sales@alfa-diesel.com.sa'], 'https://alfa-diesel.com.sa'],
        ['Gulf Fuel', ['+966502222222'], ['sales@gulf-fuel.com'], 'https://gulf-fuel.com'],
      ]],
      ['L2', [['Riyadh Gas', ['+966503333333'], ['sales@riyadh-gas.com'], 'https://riyadh-gas.com']]],
      ['L3', []],
    ]);
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
    // A code no country has.
    expect(
      (await v1('POST', '/v1/discovery/searches', { requesterRef: 'x', product: 'Diesel', side: 'suppliers', countries: ['XX'] })).status,
    ).toBe(400);
    expect((await v1('GET', '/v1/discovery/searches')).status).toBe(400);
  });
});

/** A company in the pool with exactly these identifiers, in this order. */
async function companyWith(name: string, identifiers: { type: string; value: string }[]): Promise<string> {
  const { company } = await withTenant(TENANT_A, (tx) =>
    upsert(tx, { name, country: 'SA', identifiers, source: { type: 'api', tenantId: TENANT_A } }),
  );
  return company.id;
}

/** A finished buyers search straight into the tables, ranked in the order given. */
async function buyersSearch(requesterRef: string, companyIds: string[]): Promise<string> {
  const [job] = await db()<{ id: string }[]>`
    insert into discovery_jobs (tenant_id, product, side, countries, status, requester_ref, finished_at)
    values (${TENANT_A}, 'Calcium hypochlorite', 'buyers', ${['SA']}, 'done', ${requesterRef}, now())
    returning id
  `;
  const [task] = await db()<{ id: string }[]>`
    insert into discovery_tasks (tenant_id, job_id, country, status) values (${TENANT_A}, ${job!.id}, 'SA', 'done') returning id
  `;
  for (const [i, companyId] of companyIds.entries()) {
    await db()`
      insert into discovery_results (tenant_id, job_id, task_id, company_id, rank, score, reasons, fit, tier)
      values (${TENANT_A}, ${job!.id}, ${task!.id}, ${companyId}, ${i + 1}, ${1 / (i + 1)}, ${['persona: Pool operators']}, 'strong', 'found')
    `;
  }
  return job!.id;
}

type Contacts = { company: { id: string; name: string }; phones: string[]; emails: string[]; website: string | null };

async function results(searchId: string, requesterRef: string) {
  const answer = await v1<{ results: Contacts[] }>('GET', `/v1/discovery/searches/${searchId}/results?requesterRef=${requesterRef}`);
  expect(answer.status).toBe(200);
  return answer;
}

describe('contacts on search results (brief 27)', () => {
  it('lists every phone and email oldest first, the oldest domain as the website, and empty values when none', async () => {
    const many = await companyWith('Seerah Pools', [
      { type: 'domain', value: 'https://www.Seerah-Pools.com.sa/contact' },
      { type: 'phone', value: '+966 50 123 4567' },
      { type: 'email', value: 'Info@seerah-pools.com.sa' },
      { type: 'phone', value: '+966 11 234 5678' },
      { type: 'email', value: 'sales@seerah-pools.com.sa' },
      { type: 'phone', value: '+966551112233' },
      { type: 'gmaps', value: 'ChIJseerah123' },
    ]);
    // A second domain recorded later, say from a later import. It sorts
    // first, so only the order recorded makes the other one the website.
    await withTenant(TENANT_A, (tx) =>
      upsert(tx, {
        name: 'Seerah Pools',
        identifiers: [{ type: 'domain', value: 'seerah-pools.com.sa' }, { type: 'domain', value: 'aseerah.sa' }],
        source: { type: 'import', tenantId: TENANT_A },
      }),
    );
    const domains = await db()<{ value: string }[]>`
      select value from company_identifiers where company_id = ${many} and type = 'domain' order by id
    `;
    expect(domains.map((d) => d.value)).toEqual(['seerah-pools.com.sa', 'aseerah.sa']);
    // Known only by its Maps listing: no phone, email or website held.
    const bare = await companyWith('Al Noor Compound', [{ type: 'gmaps', value: 'ChIJnoor456' }]);
    const id = await buyersSearch('sup-4411', [many, bare]);

    const answer = await results(id, 'sup-4411');
    expect(answer.body.results).toEqual([
      expect.objectContaining({
        company: { id: many, name: 'Seerah Pools' },
        phones: ['+966501234567', '+966112345678', '+966551112233'],
        emails: ['info@seerah-pools.com.sa', 'sales@seerah-pools.com.sa'],
        website: 'https://seerah-pools.com.sa',
      }),
      expect.objectContaining({ company: { id: bare, name: 'Al Noor Compound' }, phones: [], emails: [], website: null }),
    ]);
    // Present even when empty, and still never a Maps id.
    for (const r of answer.body.results) expect(Object.keys(r)).toEqual(expect.arrayContaining(['phones', 'emails', 'website']));
    expect(answer.text).not.toContain('ChIJ');
  });

  it('shows the survivor’s contacts for a company merged away since it was ranked', async () => {
    const older = await companyWith('Gulf Water', [{ type: 'domain', value: 'water-gulf.com' }, { type: 'phone', value: '+966501000001' }]);
    const newer = await companyWith('Khaleej Aqua', [{ type: 'domain', value: 'gulfwater.sa' }, { type: 'phone', value: '+966501000002' }]);
    // The survivor learns a phone after the other company's, and its domain
    // sorts after the other's: only the order recorded decides either one.
    await withTenant(TENANT_A, (tx) =>
      upsert(tx, {
        name: 'Gulf Water',
        identifiers: [{ type: 'domain', value: 'water-gulf.com' }, { type: 'phone', value: '+966501000003' }],
        source: { type: 'api', tenantId: TENANT_A },
      }),
    );
    const id = await buyersSearch('sup-1', [newer]);

    // Both domains turn up on one page: the two were one company all along.
    await withTenant(TENANT_A, (tx) =>
      upsert(tx, {
        name: 'Gulf Water',
        identifiers: [{ type: 'domain', value: 'water-gulf.com' }, { type: 'domain', value: 'gulfwater.sa' }],
        source: { type: 'api', tenantId: TENANT_A },
      }),
    );
    expect((await db()<{ merged_into: string }[]>`select merged_into from companies where id = ${newer}`)[0]!.merged_into).toBe(older);

    const answer = await results(id, 'sup-1');
    expect(answer.body.results).toEqual([
      expect.objectContaining({
        company: { id: newer, name: 'Khaleej Aqua' },
        phones: ['+966501000001', '+966501000002', '+966501000003'],
        website: 'https://water-gulf.com',
      }),
    ]);
  });

  it('still lists an address the buyer opted out of', async () => {
    const buyer = await companyWith('Palm Hotel', [
      { type: 'domain', value: 'palm-hotel.com.sa' },
      { type: 'phone', value: '+966501239999' },
      { type: 'email', value: 'events@palm-hotel.com.sa' },
    ]);
    await withTenant(TENANT_A, (tx) => suppress(tx, { tenantId: TENANT_A, channel: 'sms', address: '+966501239999', reason: 'unsubscribe' }));
    await withTenant(TENANT_A, (tx) => suppress(tx, { tenantId: TENANT_A, channel: 'email', address: 'events@palm-hotel.com.sa', reason: 'complaint' }));
    const id = await buyersSearch('sup-2', [buyer]);

    expect((await results(id, 'sup-2')).body.results).toEqual([
      expect.objectContaining({ phones: ['+966501239999'], emails: ['events@palm-hotel.com.sa'], website: 'https://palm-hotel.com.sa' }),
    ]);
  });
});
