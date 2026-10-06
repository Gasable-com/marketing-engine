import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import {
  TASK_RETRY_LIMIT,
  getFinder,
  productsFinder,
  registerFinder,
  runTask,
  setProfile,
  type FinderQuery,
  type TaskJob,
} from '../src/modules/discovery/index.js';
import {
  foldText,
  normalizeDomain,
  normalizeIdentifiers,
  setCompanyLookup,
  upsert,
  type UpsertInput,
} from '../src/spine/registry/index.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN!;

let tokenA: string;

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  auth: { token?: string; internal?: string | null } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  const internal = auth.internal === undefined ? INTERNAL_TOKEN : auth.internal;
  if (internal) headers['X-Internal-Token'] = internal;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await app.fetch(
    new Request(`http://engine.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
});

afterAll(async () => {
  setCompanyLookup(undefined);
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  setCompanyLookup(null);
});

function upsertAs(input: UpsertInput, tenantId = TENANT_A) {
  return withTenant(tenantId, (tx) => upsert(tx, { ...input, source: { ...input.source, tenantId } }));
}

describe('domains', () => {
  it('keeps the registrable domain, with two-level country suffixes', () => {
    expect(normalizeDomain('https://www.Diesel.AlfaFalArabia.com/ar?x=1')).toBe('alfafalarabia.com');
    expect(normalizeDomain('shop.example.com.sa')).toBe('example.com.sa');
    expect(normalizeDomain('x.co.ae')).toBe('x.co.ae');
  });

  it('keeps a generic second level under any country code, so its companies stay apart', () => {
    expect(normalizeDomain('https://www.acme.com.kw/en')).toBe('acme.com.kw');
    expect(normalizeDomain('mail.beta.org.qa')).toBe('beta.org.qa');
    expect(normalizeDomain('com.kw')).toBeNull();
    expect(normalizeDomain('shop.example.co')).toBe('example.co');
  });

  it('refuses a bare public suffix and an address', () => {
    expect(normalizeDomain('com.sa')).toBeNull();
    expect(normalizeDomain('http://10.0.1.1/')).toBeNull();
  });

  it('rejects a URL on a shared host as a shared host', () => {
    const { identifiers, rejected } = normalizeIdentifiers([
      { type: 'domain', value: 'https://salla.sa/abc-fuel' },
      { type: 'domain', value: 'https://ahmed.business.site' },
    ]);
    expect(identifiers).toEqual([]);
    expect(rejected).toEqual([
      { type: 'domain', value: 'https://salla.sa/abc-fuel', reason: 'shared host' },
      { type: 'domain', value: 'https://ahmed.business.site', reason: 'shared host' },
    ]);
  });

  it('takes no domain from a mailbox on a shared host, and the registrable one from any other', () => {
    const { identifiers } = normalizeIdentifiers([
      { type: 'email', value: 'shop@instagram.com' },
      { type: 'email', value: 'sales@mail.alfalah.com.sa' },
    ]);
    expect(identifiers).toEqual([
      { type: 'email', value: 'shop@instagram.com' },
      { type: 'email', value: 'sales@mail.alfalah.com.sa' },
      { type: 'domain', value: 'alfalah.com.sa' },
    ]);
  });

  it('keeps two Salla shops as two companies, and their URLs in the source', async () => {
    const abc = await upsertAs({
      name: 'ABC Fuel',
      country: 'SA',
      identifiers: [{ type: 'domain', value: 'https://salla.sa/abc-fuel' }],
      source: { type: 'web', ref: 'https://salla.sa/abc-fuel' },
    });
    const xyz = await upsertAs({
      name: 'XYZ Gas',
      country: 'SA',
      identifiers: [{ type: 'domain', value: 'https://salla.sa/xyz-gas' }],
      source: { type: 'web', ref: 'https://salla.sa/xyz-gas' },
    });

    expect(abc.created).toBe(true);
    expect(xyz.created).toBe(true);
    expect(xyz.company.id).not.toBe(abc.company.id);

    const identifiers = await db()`select * from company_identifiers`;
    expect(identifiers).toHaveLength(0);

    const [source] = await db()<{ data: { rejected: { value: string; reason: string }[] } }[]>`
      select data from company_sources where company_id = ${abc.company.id}
    `;
    expect(source!.data.rejected).toEqual([
      { type: 'domain', value: 'https://salla.sa/abc-fuel', reason: 'shared host' },
    ]);
  });
});

describe('gmaps and web sources', () => {
  it('merges on a shared Maps place id and keeps both sources', async () => {
    const PLACE = 'ChIJ3S-JXmauEmsRUcIaWtf4MzE';

    const first = await upsertAs({
      name: 'Alfa Fuel Station',
      country: 'SA',
      identifiers: [{ type: 'gmaps', value: ` ${PLACE} ` }],
      source: { type: 'maps', ref: PLACE },
    });
    const second = await upsertAs({
      name: 'شركة ألفا للمحروقات',
      country: 'SA',
      identifiers: [{ type: 'gmaps', value: PLACE }],
      source: { type: 'web', ref: 'https://alfa.example.com' },
    });

    expect(second.created).toBe(false);
    expect(second.company.id).toBe(first.company.id);

    const sources = await db()<{ source_type: string }[]>`
      select source_type from company_sources where company_id = ${first.company.id} order by id
    `;
    expect(sources.map((s) => s.source_type)).toEqual(['maps', 'web']);

    const ids = await db()<{ type: string; value: string }[]>`
      select type, value from company_identifiers where company_id = ${first.company.id}
    `;
    expect(ids).toEqual([{ type: 'gmaps', value: PLACE }]);
  });

  it('rejects a place id with characters Google never uses', () => {
    const { identifiers, rejected } = normalizeIdentifiers([{ type: 'gmaps', value: 'place id?' }]);
    expect(identifiers).toEqual([]);
    expect(rejected[0]?.reason).toBe('not a Google Maps place id');
  });
});

describe('profiles', () => {
  async function company() {
    const { company } = await upsertAs({
      name: 'Diesel Co',
      country: 'SA',
      identifiers: [],
      source: { type: 'api' },
    });
    return company.id;
  }

  it('takes products, roles, cities, countries, quality and when it was profiled', async () => {
    const id = await company();
    const res = await call<{ profile: Record<string, unknown> }>(
      'PUT',
      `/v1/companies/${id}/profile`,
      {
        sells: ['diesel'],
        products: ['توريد الديزل', 'Diesel fuel'],
        roles: ['distributor'],
        cities: ['Riyadh'],
        countries: ['sa', 'AE'],
        quality: 'full',
        profiledAt: '2026-10-01T00:00:00Z',
      },
      { token: tokenA, internal: null },
    );

    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({
      sells: ['diesel'],
      products: ['توريد الديزل', 'Diesel fuel'],
      roles: ['distributor'],
      cities: ['Riyadh'],
      countries: ['SA', 'AE'],
      quality: 'full',
      profiled_at: '2026-10-01T00:00:00.000Z',
    });

    // A later write that says nothing about them leaves them alone.
    const again = await call<{ profile: Record<string, unknown> }>(
      'PUT',
      `/v1/companies/${id}/profile`,
      { sector: 'energy' },
      { token: tokenA, internal: null },
    );
    expect(again.body.profile).toMatchObject({ sector: 'energy', products: ['توريد الديزل', 'Diesel fuel'], quality: 'full' });
  });

  it('refuses what the columns would refuse', async () => {
    const id = await company();
    for (const body of [
      { roles: ['broker'] },
      { countries: ['Saudi'] },
      { quality: 'great' },
      { products: [''] },
      { profiledAt: null },
      { profiledAt: 5 },
      { profiledAt: 'yesterday' },
    ]) {
      const res = await call('PUT', `/v1/companies/${id}/profile`, body, { token: tokenA, internal: null });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

const DAY = 24 * 60 * 60 * 1000;

type Pool = Record<'a' | 'b' | 'c' | 'd' | 'e', string>;

/**
 * The brief's pool: (a) a diesel distributor in Riyadh, full, profiled five
 * days ago; (b) a diesel retailer in Jeddah, thin; (c) LPG in Riyadh; (d) a
 * diesel company already on the marketplace; (e) a merged-away diesel company.
 */
async function seedPool(): Promise<Pool> {
  async function add(name: string, profile: Omit<Parameters<typeof setProfile>[1], 'tenantId' | 'companyId'>) {
    const { company } = await upsertAs({ name, country: 'SA', identifiers: [], source: { type: 'api' } });
    await withTenant(TENANT_A, (tx) => setProfile(tx, { tenantId: TENANT_A, companyId: company.id, ...profile }));
    return company.id;
  }

  const a = await add('Riyadh Diesel Distribution', {
    products: ['توريد الديزل'],
    roles: ['distributor'],
    cities: ['Riyadh'],
    quality: 'full',
    profiledAt: new Date(Date.now() - 5 * DAY),
  });
  const b = await add('Jeddah Fuel Retail', {
    products: ['Diesel fuel'],
    roles: ['retailer'],
    cities: ['Jeddah'],
    quality: 'thin',
  });
  const c = await add('Riyadh Gas Cylinders', {
    products: ['LPG cylinders', 'غاز البترول المسال'],
    roles: ['distributor'],
    cities: ['Riyadh'],
    quality: 'full',
  });
  const d = await add('Platform Diesel Member', { products: ['Diesel'], cities: ['Riyadh'] });
  const e = await add('Old Diesel Duplicate', { products: ['Diesel supply'], cities: ['Riyadh'] });

  await db()`update companies set on_platform_ref = 'mkt-1', on_platform_at = now() where id = ${d}`;
  await db()`update companies set merged_into = ${a} where id = ${e}`;
  return { a, b, c, d, e };
}

function rank(query: Partial<FinderQuery>) {
  return withTenant(TENANT_A, (tx) => getFinder('products').find(tx, TENANT_A, { limit: 50, ...query }));
}

describe('profile columns', () => {
  it('refuse a country list with an empty, joined or lower-case element', async () => {
    const { company } = await upsertAs({ name: 'Checks Co', identifiers: [], source: { type: 'api' } });
    for (const countries of [['SA', null], ['SA,AE'], ['sa']]) {
      await expect(
        db()`insert into company_profiles (company_id, countries) values (${company.id}, ${countries as string[]})`,
      ).rejects.toThrow(/company_profiles_countries_check/);
    }
  });

  it('refuse a job with the same country twice', async () => {
    await expect(
      db()`insert into discovery_jobs (tenant_id, product, countries, status)
           values (${TENANT_A}, 'diesel', ${['SA', 'SA']}, 'running')`,
    ).rejects.toThrow(/discovery_jobs_countries_check/);
  });
});

describe('products finder', () => {
  it('folds in SQL exactly as foldText does', async () => {
    const samples = [
      'شَرِكة  إبراهيم للتجارة — Diesel-Fuel_Supply!',
      'مؤسّسة ٱلديزل ى ئ ؤ آ',
      'ـتـوريـد   الديزل/البنزين',
      'Café LPG & Co. ١٢٣ 456',
    ];
    for (const text of samples) {
      const [row] = await db()<{ folded: string }[]>`select fold_text(${text}) as folded`;
      expect(row!.folded, text).toBe(foldText(text));
    }
  });

  it('finds the companies that sell the product in the country, and nobody else', async () => {
    const pool = await seedPool();
    const found = await rank({ products: ['ديزل', 'diesel'], country: 'SA' });
    expect(found.map((f) => f.companyId)).toEqual([pool.a, pool.b]);
    expect(found[0]!.reasons).toEqual([
      'product: ديزل ~ توريد الديزل',
      'profile: full',
      'profiled 5 days ago',
    ]);
    expect(found[1]!.reasons).toEqual(['product: diesel ~ Diesel fuel', 'profile: thin']);
    expect(found[0]!.score).toBeCloseTo(0.5 + 0.1 + 0.1, 5);
    expect(found[1]!.score).toBeCloseTo(0.5 + 0.05, 5);
  });

  it('lets a city decide between two that otherwise rank the other way', async () => {
    const pool = await seedPool();

    const byRole = await rank({ products: ['ديزل', 'diesel'], country: 'SA', roles: ['retailer'] });
    expect(byRole.map((f) => f.companyId)).toEqual([pool.b, pool.a]);

    const byCity = await rank({ products: ['ديزل', 'diesel'], country: 'SA', roles: ['retailer'], cities: ['Riyadh'] });
    expect(byCity.map((f) => f.companyId)).toEqual([pool.a, pool.b]);

    const withCity = await rank({ products: ['ديزل', 'diesel'], country: 'SA', cities: ['riyadh'] });
    expect(withCity[0]!.companyId).toBe(pool.a);
    expect(withCity[0]!.reasons).toContain('product: ديزل ~ توريد الديزل');
    expect(withCity[0]!.reasons).toContain('city: Riyadh');
  });

  it('matches through the folding, in Arabic and English', async () => {
    const pool = await seedPool();
    expect((await rank({ products: ['الديزل'] })).map((f) => f.companyId)).toEqual([pool.a]);
    expect((await rank({ products: ['ديزل'] })).map((f) => f.companyId)).toEqual([pool.a]);
    expect((await rank({ products: ['diesel'] })).map((f) => f.companyId)).toEqual([pool.b]);
    expect((await rank({ products: ['DIESEL FUEL'] })).map((f) => f.companyId)).toEqual([pool.b]);
  });

  it('credits the earlier term when two match equally', async () => {
    const pool = await seedPool();
    const [b] = await rank({ products: ['fuel', 'diesel'], country: 'SA', limit: 50 }).then((r) =>
      r.filter((f) => f.companyId === pool.b),
    );
    expect(b!.reasons[0]).toBe('product: fuel ~ Diesel fuel');
  });

  it('folds a city the same way on both sides, whatever the script', async () => {
    const pool = await seedPool();
    await withTenant(TENANT_A, (tx) => setProfile(tx, { tenantId: TENANT_A, companyId: pool.b, cities: ['İzmir'] }));
    const found = await rank({ products: ['diesel'], cities: ['İzmir'] });
    expect(found[0]!.reasons).toContain('city: İzmir');
  });

  it('takes a country from the profile as well as the company', async () => {
    const pool = await seedPool();
    expect(await rank({ products: ['diesel'], country: 'AE' })).toEqual([]);

    await withTenant(TENANT_A, (tx) => setProfile(tx, { tenantId: TENANT_A, companyId: pool.b, countries: ['AE'] }));
    expect((await rank({ products: ['diesel'], country: 'AE' })).map((f) => f.companyId)).toEqual([pool.b]);
  });

  it('never returns more than the limit, and nothing without a term', async () => {
    await seedPool();
    expect(await rank({ products: ['ديزل', 'diesel'], country: 'SA', limit: 1 })).toHaveLength(1);
    expect(await rank({ products: [' ! '] })).toEqual([]);
    expect(await rank({})).toEqual([]);
  });

  it('fades freshness between 90 and 365 days', async () => {
    const pool = await seedPool();
    await db()`update company_profiles set profiled_at = now() - interval '200 days' where company_id = ${pool.a}`;
    const [a] = await rank({ products: ['ديزل'] });
    expect(a!.score).toBeCloseTo(0.5 + 0.1 + 0.1 * (165 / 275), 3);
    expect(a!.reasons).toContain('profiled 200 days ago');

    await db()`update company_profiles set profiled_at = now() - interval '400 days' where company_id = ${pool.a}`;
    const [stale] = await rank({ products: ['ديزل'] });
    expect(stale!.score).toBeCloseTo(0.6, 5);
    expect(stale!.reasons.some((r) => r.startsWith('profiled'))).toBe(false);
  });
});

type QueuedTask = { id: string; data: TaskJob; singleton_key: string; retry_limit: number };

/** Waiting task jobs, in the order of the job's countries. */
async function queuedTasks(): Promise<QueuedTask[]> {
  return db()<QueuedTask[]>`
    select j.id::text, j.data, j.singleton_key, j.retry_limit
    from pgboss.job j
    join discovery_tasks t on t.id = (j.data->>'taskId')::uuid
    join discovery_jobs d on d.id = t.job_id
    where j.name = 'discovery.task' and j.state = 'created'
    order by d.created_at, array_position(d.countries, t.country)
  `;
}

/**
 * Step 19 fills a job's search terms. Until then a test stands in for it, so
 * an Arabic product name also reaches a company that lists it in English.
 */
async function setTerms(jobId: string, terms: string[]) {
  await db()`update discovery_jobs set terms = ${terms} where id = ${jobId}`;
}

/** Drive the task worker by hand: take each waiting job, delete it, run it. */
async function drive(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const [job] = await queuedTasks();
    if (!job) return;
    await db()`delete from pgboss.job where id = ${job.id}`;
    await runTask(job.data, { finalAttempt: true });
  }
  throw new Error('drive did not settle');
}

async function discoveryEvents(): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  return db()`select type, payload from events where type like 'discovery.%' order by id`;
}

type JobDetail = {
  job: { id: string; tenantId: string; tenantName: string; status: string; counts: Record<string, number>; finishedAt: string | null };
  tasks: { id: string; country: string; status: string; stage: string | null; counts: Record<string, number>; error: string | null; attempts: number }[];
};

type ResultPage = {
  items: {
    rank: number;
    score: number;
    reasons: string[];
    country: string;
    company: { id: string; name: string; country: string };
    profile: { products: string[]; roles: string[]; cities: string[]; quality: string | null; profiledAt: string | null } | null;
    identifiers: { type: string; value: string }[];
  }[];
  nextCursor: string | null;
};

function createJob(body: Record<string, unknown>) {
  return call<JobDetail>('POST', '/internal/discovery/jobs', body);
}

describe('a job end to end', () => {
  it('ranks the pool per country through the queue and sums the counts', async () => {
    const pool = await seedPool();
    await upsertAs({
      name: 'Riyadh Diesel Distribution',
      country: 'SA',
      identifiers: [
        { type: 'domain', value: 'https://www.riyadh-diesel.com.sa/ar' },
        { type: 'phone', value: '+966501234567' },
        { type: 'gmaps', value: 'ChIJ-riyadh-diesel' },
      ],
      source: { type: 'web' },
    });

    const created = await createJob({ tenantId: TENANT_A, product: 'ديزل', countries: ['SA', 'ae'] });
    expect(created.status).toBe(201);
    expect(created.body.job).toMatchObject({ tenantId: TENANT_A, tenantName: 'Tenant A', status: 'running' });
    expect(created.body.tasks.map((t) => [t.country, t.status])).toEqual([
      ['SA', 'queued'],
      ['AE', 'queued'],
    ]);

    const queued = await queuedTasks();
    expect(queued.map((q) => q.singleton_key)).toEqual(created.body.tasks.map((t) => t.id));
    expect(queued.every((q) => q.retry_limit === TASK_RETRY_LIMIT)).toBe(true);

    const jobId = created.body.job.id;
    await setTerms(jobId, ['diesel']);
    await drive();

    const detail = await call<JobDetail>('GET', `/internal/discovery/jobs/${jobId}`);
    expect(detail.body.tasks.map((t) => [t.country, t.status, t.stage, t.counts, t.attempts])).toEqual([
      ['SA', 'done', 'rank', { ranked: 2 }, 1],
      ['AE', 'done', 'rank', { ranked: 0 }, 1],
    ]);
    expect(detail.body.job.status).toBe('done');
    expect(detail.body.job.counts).toEqual({ ranked: 2 });
    expect(detail.body.job.finishedAt).not.toBeNull();

    const sa = await call<ResultPage>('GET', `/internal/discovery/jobs/${jobId}/results?country=SA`);
    expect(sa.body.items.map((r) => [r.rank, r.company.id])).toEqual([
      [1, pool.a],
      [2, pool.b],
    ]);
    expect(sa.body.items[0]).toMatchObject({
      country: 'SA',
      company: { id: pool.a, name: 'Riyadh Diesel Distribution', country: 'SA' },
      profile: { products: ['توريد الديزل'], roles: ['distributor'], cities: ['Riyadh'], quality: 'full' },
      identifiers: [
        { type: 'domain', value: 'riyadh-diesel.com.sa' },
        { type: 'gmaps', value: 'ChIJ-riyadh-diesel' },
        { type: 'phone', value: '+966501234567' },
      ],
    });
    expect(sa.body.items[0]!.reasons).toContain('product: ديزل ~ توريد الديزل');
    expect(sa.body.items[0]!.score).toBeGreaterThan(sa.body.items[1]!.score);

    const ae = await call<ResultPage>('GET', `/internal/discovery/jobs/${jobId}/results?country=AE`);
    expect(ae.body.items).toEqual([]);

    const paged = await call<ResultPage>('GET', `/internal/discovery/jobs/${jobId}/results?limit=1`);
    expect(paged.body.items.map((r) => r.company.id)).toEqual([pool.a]);
    const next = await call<ResultPage>(
      'GET',
      `/internal/discovery/jobs/${jobId}/results?limit=1&cursor=${paged.body.nextCursor}`,
    );
    expect(next.body.items.map((r) => r.company.id)).toEqual([pool.b]);

    expect((await discoveryEvents()).map((e) => e.type)).toEqual([
      'discovery.job.created',
      'discovery.task.finished',
      'discovery.task.finished',
      'discovery.job.finished',
    ]);
    const [createdEvent] = await discoveryEvents();
    expect(createdEvent!.payload).toEqual({ jobId, product: 'ديزل', countries: ['SA', 'AE'] });

    const runs = await db()<{ finder: string; result_count: number }[]>`
      select finder, result_count from finder_runs where tenant_id = ${TENANT_A} order by id
    `;
    expect(runs).toEqual([
      { finder: 'products', result_count: 2 },
      { finder: 'products', result_count: 0 },
    ]);

    const list = await call<{ items: Record<string, unknown>[] }>('GET', `/internal/discovery/jobs?tenantId=${TENANT_A}&status=done`);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        id: jobId,
        tenantId: TENANT_A,
        tenantName: 'Tenant A',
        product: 'ديزل',
        category: null,
        countries: ['SA', 'AE'],
        status: 'done',
        counts: { ranked: 2 },
      }),
    ]);
  });

  it('does nothing for a task delivered again after it finished', async () => {
    await seedPool();
    await createJob({ tenantId: TENANT_A, product: 'diesel', countries: ['SA'] });
    const [job] = await queuedTasks();
    await drive();

    expect(await runTask(job!.data)).toBe('skipped');
    expect((await discoveryEvents()).map((e) => e.type)).toEqual([
      'discovery.job.created',
      'discovery.task.finished',
      'discovery.job.finished',
    ]);
  });

  it('finishes the job exactly once when its tasks finish together', async () => {
    await seedPool();
    await createJob({ tenantId: TENANT_A, product: 'diesel', countries: ['SA', 'AE', 'EG', 'KW'] });
    const jobs = await queuedTasks();

    await Promise.all(jobs.map((job) => runTask(job.data)));

    const types = (await discoveryEvents()).map((e) => e.type);
    expect(types.filter((t) => t === 'discovery.task.finished')).toHaveLength(4);
    expect(types.filter((t) => t === 'discovery.job.finished')).toHaveLength(1);
  });
});

describe('tenants', () => {
  it("keeps tenant A's job, tasks and results from tenant B", async () => {
    await seedPool();
    const created = await createJob({ tenantId: TENANT_A, product: 'ديزل', countries: ['SA'] });
    const jobId = created.body.job.id;
    await setTerms(jobId, ['diesel']);
    await drive();

    const seen = (tenantId: string) =>
      withTenant(tenantId, async (tx) => ({
        jobs: (await tx`select id from discovery_jobs where id = ${jobId}`).length,
        tasks: (await tx`select id from discovery_tasks where job_id = ${jobId}`).length,
        results: (await tx`select id from discovery_results where job_id = ${jobId}`).length,
      }));

    expect(await seen(TENANT_A)).toEqual({ jobs: 1, tasks: 1, results: 2 });
    expect(await seen(TENANT_B)).toEqual({ jobs: 0, tasks: 0, results: 0 });
  });
});

describe('validation', () => {
  it('refuses a bad country, an empty product, an unknown tenant and a missing token', async () => {
    expect((await createJob({ tenantId: TENANT_A, product: 'ديزل', countries: ['Saudi'] })).status).toBe(400);
    expect((await createJob({ tenantId: TENANT_A, product: '', countries: ['SA'] })).status).toBe(400);
    expect((await createJob({ tenantId: TENANT_A, product: '  x ', countries: ['SA'] })).status).toBe(400);
    expect((await createJob({ tenantId: TENANT_A, product: 'ديزل', countries: ['SA', 'sa'] })).status).toBe(400);
    expect((await createJob({ tenantId: TENANT_A, product: 'ديزل', countries: [] })).status).toBe(400);
    expect(
      (await createJob({ tenantId: '33333333-3333-3333-3333-333333333333', product: 'ديزل', countries: ['SA'] }))
        .status,
    ).toBe(404);

    const body = { tenantId: TENANT_A, product: 'ديزل', countries: ['SA'] };
    expect((await call('POST', '/internal/discovery/jobs', body, { internal: null })).status).toBe(401);
    expect((await call('POST', '/internal/discovery/jobs', body, { internal: null, token: tokenA })).status).toBe(401);
    expect((await call('GET', '/internal/discovery/jobs', undefined, { internal: null })).status).toBe(401);

    expect(await db()`select id from discovery_jobs`).toHaveLength(0);
    expect(await queuedTasks()).toHaveLength(0);
  });

  it('answers 404 for a job that does not exist', async () => {
    const missing = '44444444-4444-4444-4444-444444444444';
    expect((await call('GET', `/internal/discovery/jobs/${missing}`)).status).toBe(404);
    expect((await call('GET', `/internal/discovery/jobs/${missing}/results`)).status).toBe(404);
    expect((await call('GET', '/internal/discovery/jobs/not-a-uuid')).status).toBe(404);
  });
});

describe('failure', () => {
  async function attemptAll(job: QueuedTask) {
    for (let attempt = 0; attempt <= TASK_RETRY_LIMIT; attempt += 1) {
      await expect(runTask(job.data, { finalAttempt: attempt >= TASK_RETRY_LIMIT })).rejects.toThrow(
        'finder exploded',
      );
    }
  }

  it('fails the task on its final attempt, and the job when every task failed', async () => {
    registerFinder({
      name: 'products',
      async find() {
        throw new Error('finder exploded');
      },
    });
    try {
      await seedPool();
      const created = await createJob({ tenantId: TENANT_A, product: 'ديزل', countries: ['SA'] });
      const [job] = await queuedTasks();

      await expect(runTask(job!.data, { finalAttempt: false })).rejects.toThrow('finder exploded');
      const [midway] = await db()<{ status: string; error: string | null }[]>`
        select status, error from discovery_tasks where id = ${job!.data.taskId}
      `;
      expect(midway).toEqual({ status: 'running', error: null });

      await attemptAll(job!);

      const detail = await call<JobDetail>('GET', `/internal/discovery/jobs/${created.body.job.id}`);
      expect(detail.body.tasks[0]).toMatchObject({
        status: 'failed',
        stage: 'rank',
        error: 'finder exploded',
        attempts: TASK_RETRY_LIMIT + 2,
      });
      expect(detail.body.job.status).toBe('failed');

      const events = await discoveryEvents();
      expect(events.map((e) => e.type)).toEqual([
        'discovery.job.created',
        'discovery.task.failed',
        'discovery.job.finished',
      ]);
      expect(events[1]!.payload).toMatchObject({ country: 'SA', error: 'finder exploded' });
      expect(events[2]!.payload).toMatchObject({ status: 'failed' });
    } finally {
      registerFinder(productsFinder);
    }
  });

  it('finishes the job done when at least one task is done', async () => {
    registerFinder({
      name: 'products',
      async find(tx, tenantId, query) {
        if (query.country === 'AE') throw new Error('finder exploded');
        return productsFinder.find(tx, tenantId, query);
      },
    });
    try {
      await seedPool();
      const created = await createJob({ tenantId: TENANT_A, product: 'ديزل', countries: ['SA', 'AE'] });
      await setTerms(created.body.job.id, ['diesel']);
      const [sa, ae] = await queuedTasks();

      await runTask(sa!.data);
      await attemptAll(ae!);

      const detail = await call<JobDetail>('GET', `/internal/discovery/jobs/${created.body.job.id}`);
      expect(detail.body.tasks.map((t) => [t.country, t.status])).toEqual([
        ['SA', 'done'],
        ['AE', 'failed'],
      ]);
      expect(detail.body.job).toMatchObject({ status: 'done', counts: { ranked: 2 } });
    } finally {
      registerFinder(productsFinder);
    }
  });
});
