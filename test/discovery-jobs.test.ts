import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, withTenant } from '../src/db/client.js';
import {
  normalizeDomain,
  normalizeIdentifiers,
  setCompanyLookup,
  upsert,
  type UpsertInput,
} from '../src/spine/registry/index.js';
import { TENANT_A, resetDb, startQueue, teardownDb } from './helpers.js';

beforeAll(async () => {
  await resetDb();
  await startQueue();
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
