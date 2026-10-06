import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { getFinder, setProfile, type FinderQuery } from '../src/modules/discovery/index.js';
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
