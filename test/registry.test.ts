import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { resetFake } from '../src/modules/messaging/adapters/fake.js';
import {
  canonicalSocial,
  fakeLookup,
  groupSocials,
  normalizeIdentifiers,
  normalizeName,
  resetFakeLookup,
  seedFakeLookup,
  setCompanyLookup,
} from '../src/spine/registry/index.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();

const CR = '1010123456';
const OTHER_CR = '4030999888';
const PHONE = '+966501234567';

let tokenA: string;
let tokenB: string;

function request(path: string, init: RequestInit = {}, token: string | null = tokenA) {
  return app.fetch(
    new Request(`http://engine.test${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    }),
  );
}

const json = (body: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

type Created = {
  company: { id: string; name: string; country: string | null; merged_into: string | null };
  created: boolean;
  mergedFrom: string[];
};

async function postCompany(body: Record<string, unknown>, token = tokenA): Promise<Created> {
  const res = await request('/v1/companies', { method: 'POST', ...json(body) }, token);
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

beforeAll(async () => {
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(async () => {
  setCompanyLookup(undefined);
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  resetFake();
  resetFakeLookup();
  setCompanyLookup(null);
});

describe('normalisation', () => {
  it('folds legal forms and case to the same name', () => {
    expect(normalizeName('Al-Falah Trading Co. Ltd')).toBe(normalizeName('AL FALAH TRADING'));
  });

  it('derives a domain from a company email but not a free-mail one', () => {
    const free = normalizeIdentifiers([{ type: 'email', value: 'info@gmail.com' }]);
    expect(free.identifiers).toEqual([{ type: 'email', value: 'info@gmail.com' }]);

    const owned = normalizeIdentifiers([{ type: 'email', value: 'sales@alfalah.com.sa' }]);
    expect(owned.identifiers).toEqual([
      { type: 'email', value: 'sales@alfalah.com.sa' },
      { type: 'domain', value: 'alfalah.com.sa' },
    ]);
  });
});

describe('social profiles', () => {
  it.each([
    // LinkedIn: any subdomain, anything after the slug dropped.
    ['https://www.linkedin.com/company/gasable/mycompany/verification/', 'linkedin', 'linkedin.com/company/gasable'],
    ['https://sa.linkedin.com/company/x?trk=public_profile', 'linkedin', 'linkedin.com/company/x'],
    ['linkedin.com/company/Acme-Co/about/', 'linkedin', 'linkedin.com/company/acme-co'],
    ['//ae.linkedin.com/company/acme', 'linkedin', 'linkedin.com/company/acme'],
    // Instagram.
    ['https://www.instagram.com/Acme.Co/', 'instagram', 'instagram.com/acme.co'],
    ['https://instagram.com/acme?igsh=abc', 'instagram', 'instagram.com/acme'],
    // X, also as twitter.com.
    ['https://twitter.com/Acme', 'x', 'x.com/acme'],
    ['https://x.com/acme_sa?lang=ar', 'x', 'x.com/acme_sa'],
    ['https://mobile.twitter.com/acme', 'x', 'x.com/acme'],
    // Facebook: fb.com, m., web., locale subdomains, and profile.php by id.
    ['https://m.facebook.com/AcmeCo/', 'facebook', 'facebook.com/acmeco'],
    ['https://web.facebook.com/acmeco?_rdc=1', 'facebook', 'facebook.com/acmeco'],
    ['https://ar-ar.facebook.com/acme.sa', 'facebook', 'facebook.com/acme.sa'],
    ['https://fb.com/acmeco', 'facebook', 'facebook.com/acmeco'],
    ['https://www.facebook.com/profile.php?id=100064&ref=footer', 'facebook', 'facebook.com/profile.php?id=100064'],
    // TikTok.
    ['https://www.tiktok.com/@Acme.sa?lang=en', 'tiktok', 'tiktok.com/@acme.sa'],
    // YouTube's four forms; a channel id keeps its case, its link needs it.
    ['https://www.youtube.com/@AcmeCo', 'youtube', 'youtube.com/@acmeco'],
    ['https://youtube.com/channel/UCa1B2c3/videos', 'youtube', 'youtube.com/channel/UCa1B2c3'],
    ['https://www.youtube.com/c/AcmeCo', 'youtube', 'youtube.com/c/acmeco'],
    ['https://www.youtube.com/user/acmeco', 'youtube', 'youtube.com/user/acmeco'],
    // Snapchat.
    ['https://www.snapchat.com/add/Acme_sa?share_id=1', 'snapchat', 'snapchat.com/add/acme_sa'],
  ])('takes %s', (url, network, value) => {
    expect(canonicalSocial(url)).toEqual({ network, value });
  });

  it.each([
    'https://www.linkedin.com/in/someone/',
    'https://www.linkedin.com/school/kfupm/',
    'https://www.linkedin.com/showcase/acme-labs/',
    'https://www.linkedin.com/jobs/view/123',
    'https://www.linkedin.com/pulse/some-article',
    'https://www.linkedin.com/posts/acme_activity-1',
    'https://www.linkedin.com/feed/',
    'https://www.linkedin.com/shareArticle?mini=true&url=https://acme.sa',
    'https://www.linkedin.com/sharing/share-offsite/?url=https://acme.sa',
    'https://www.linkedin.com/company/',
    'https://www.instagram.com/p/Cx1/',
    'https://www.instagram.com/reel/Cx1/',
    'https://www.instagram.com/explore/tags/acme/',
    'https://www.instagram.com/accounts/login/',
    'https://www.instagram.com/stories/acme/1/',
    'https://twitter.com/intent/tweet?text=hi',
    'https://twitter.com/share?url=https://acme.sa',
    'https://x.com/i/flow/login',
    'https://x.com/hashtag/acme',
    'https://x.com/search?q=acme',
    'https://www.facebook.com/sharer/sharer.php?u=https://acme.sa',
    'https://www.facebook.com/sharer.php?u=https://acme.sa',
    'https://www.facebook.com/share.php?u=https://acme.sa',
    'https://www.facebook.com/dialog/share?app_id=1',
    'https://www.facebook.com/plugins/page.php?href=x',
    'https://www.facebook.com/events/123/',
    'https://www.facebook.com/photo/?fbid=1',
    'https://www.facebook.com/watch/?v=1',
    'https://www.facebook.com/tr?id=1&ev=PageView',
    'https://www.facebook.com/profile.php',
    'https://www.facebook.com/',
    'https://www.tiktok.com/@acme/video/123',
    'https://www.tiktok.com/tag/acme',
    'https://vm.tiktok.com/ZMabc/',
    'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/embed/abc',
    'https://www.youtube.com/playlist?list=PL1',
    'https://www.youtube.com/shorts/abc',
    'https://youtu.be/abc',
    'https://www.snapchat.com/discover/acme',
    'https://acme.sa/linkedin.com/company/acme',
    'mailto:info@acme.sa',
    'not a url at all',
  ])('refuses %s', (url) => {
    expect(canonicalSocial(url)).toBeNull();
  });

  it('normalises a social identifier and rejects what is not a profile', () => {
    const result = normalizeIdentifiers([
      { type: 'social', value: 'https://sa.linkedin.com/company/Acme?trk=x' },
      { type: 'social', value: 'https://www.linkedin.com/company/acme/' },
      { type: 'social', value: 'https://www.linkedin.com/in/someone' },
    ]);
    expect(result.identifiers).toEqual([{ type: 'social', value: 'linkedin.com/company/acme' }]);
    expect(result.rejected).toEqual([
      { type: 'social', value: 'https://www.linkedin.com/in/someone', reason: 'not a social profile' },
    ]);
  });

  it('groups profiles into links, LinkedIn first, only networks present', () => {
    const socials = groupSocials([
      { type: 'domain', value: 'acme.sa' },
      { type: 'social', value: 'instagram.com/acme' },
      { type: 'social', value: 'x.com/acme' },
      { type: 'social', value: 'instagram.com/acme.ar' },
      { type: 'social', value: 'linkedin.com/company/acme' },
    ]);
    expect(socials).toEqual({
      linkedin: ['https://linkedin.com/company/acme'],
      instagram: ['https://instagram.com/acme', 'https://instagram.com/acme.ar'],
      x: ['https://x.com/acme'],
    });
    expect(Object.keys(socials)).toEqual(['linkedin', 'instagram', 'x']);
    expect(groupSocials([{ type: 'phone', value: PHONE }])).toEqual({});
  });
});

describe('upsert', () => {
  it('makes one company from three doors, with a source row each', async () => {
    const first = await postCompany({
      name: 'Al Falah Trading',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'import', ref: 'file.csv:2' },
    });
    expect(first.created).toBe(true);

    for (const type of ['api', 'rfq'] as const) {
      const again = await postCompany({
        name: 'Al Falah Trading',
        identifiers: [{ type: 'cr', value: CR }],
        source: { type, ref: `${type}-1` },
      });
      expect(again.created).toBe(false);
      expect(again.company.id).toBe(first.company.id);
    }

    const companies = await db()`select id from companies`;
    expect(companies).toHaveLength(1);

    const sources = await withTenant(
      TENANT_A,
      (tx) => tx`select source_type from company_sources where company_id = ${first.company.id}`,
    );
    expect(sources).toHaveLength(3);
  });

  it('merges two companies when one record carries both their identifiers', async () => {
    const x = await postCompany({
      name: 'Al Falah',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'import', ref: 'x' },
    });
    const y = await postCompany({
      name: 'Falah Group',
      identifiers: [{ type: 'domain', value: 'alfalah.com.sa' }],
      source: { type: 'import', ref: 'y' },
    });
    expect(y.company.id).not.toBe(x.company.id);

    const merged = await postCompany({
      name: 'Al Falah Trading',
      identifiers: [
        { type: 'cr', value: CR },
        { type: 'domain', value: 'alfalah.com.sa' },
      ],
      source: { type: 'api', ref: 'both' },
    });

    // The older row survives.
    expect(merged.company.id).toBe(x.company.id);
    expect(merged.mergedFrom).toEqual([y.company.id]);

    const [loser] = await db()<{ merged_into: string }[]>`
      select merged_into from companies where id = ${y.company.id}
    `;
    expect(loser!.merged_into).toBe(x.company.id);

    // Identifiers and sources followed the survivor.
    const identifiers = await db()`
      select id from company_identifiers where company_id = ${x.company.id}
    `;
    expect(identifiers).toHaveLength(2);
    const orphanSources = await db()`
      select id from company_sources where company_id = ${y.company.id}
    `;
    expect(orphanSources).toHaveLength(0);

    // Asking for the loser gives the survivor.
    const res = await request(`/v1/companies/${y.company.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { company: { id: string } };
    expect(detail.company.id).toBe(x.company.id);

    const events = await withTenant(
      TENANT_A,
      (tx) => tx<{ payload: { losers: string[] } }[]>`
        select payload from events where type = 'company.merged'
      `,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.losers).toEqual([y.company.id]);
  });

  it('links a near-identical Arabic name but keeps different ones apart', async () => {
    const first = await postCompany({
      name: 'شركة الفلاح للتجارة',
      country: 'SA',
      identifiers: [],
      source: { type: 'import', ref: '1' },
    });
    const second = await postCompany({
      name: 'الفلاح للتجاره',
      country: 'SA',
      identifiers: [],
      source: { type: 'import', ref: '2' },
    });
    expect(second.created).toBe(false);
    expect(second.company.id).toBe(first.company.id);

    const other = await postCompany({
      name: 'شركة النور',
      country: 'SA',
      identifiers: [],
      source: { type: 'import', ref: '3' },
    });
    expect(other.created).toBe(true);
    expect(other.company.id).not.toBe(first.company.id);
  });

  it('leaves a weak identifier with the company that already had it', async () => {
    const a = await postCompany({
      name: 'Company A',
      identifiers: [
        { type: 'cr', value: CR },
        { type: 'phone', value: PHONE },
      ],
      source: { type: 'import', ref: 'a' },
    });

    const b = await postCompany({
      name: 'Company B',
      identifiers: [
        { type: 'cr', value: OTHER_CR },
        { type: 'phone', value: PHONE },
      ],
      source: { type: 'import', ref: 'b' },
    });

    expect(b.company.id).not.toBe(a.company.id);

    // B keeps its own CR; the phone stays with A.
    const [phoneOwner] = await db()<{ company_id: string }[]>`
      select company_id from company_identifiers where type = 'phone' and value = ${PHONE}
    `;
    expect(phoneOwner!.company_id).toBe(a.company.id);

    const [source] = await withTenant(
      TENANT_A,
      (tx) => tx<{ data: { conflicts?: { type: string; value: string }[] } }[]>`
        select data from company_sources where company_id = ${b.company.id}
      `,
    );
    expect(source!.data.conflicts).toEqual([
      { type: 'phone', value: PHONE, heldBy: a.company.id },
    ]);
  });
});

describe('social identifiers', () => {
  it('leaves a social profile with the first company and merges nothing', async () => {
    // A web agency's Instagram, linked from two clients' footers.
    const agency = 'https://www.instagram.com/webagency/';
    const a = await postCompany({
      name: 'Company A',
      identifiers: [
        { type: 'cr', value: CR },
        { type: 'social', value: agency },
      ],
      source: { type: 'api', ref: 'a' },
    });
    const b = await postCompany({
      name: 'Company B',
      identifiers: [
        { type: 'cr', value: OTHER_CR },
        { type: 'social', value: agency },
      ],
      source: { type: 'api', ref: 'b' },
    });

    expect(b.company.id).not.toBe(a.company.id);
    expect(b.mergedFrom).toEqual([]);

    const holders = await db()<{ company_id: string }[]>`
      select company_id from company_identifiers where type = 'social'
    `;
    expect(holders).toEqual([{ company_id: a.company.id }]);

    const [source] = await withTenant(
      TENANT_A,
      (tx) => tx<{ data: { conflicts?: unknown[] } }[]>`
        select data from company_sources where company_id = ${b.company.id}
      `,
    );
    expect(source!.data.conflicts).toEqual([
      { type: 'social', value: 'instagram.com/webagency', heldBy: a.company.id },
    ]);
  });

  it('stores a posted profile in canonical form, rejects a person, and finds by it', async () => {
    const created = await postCompany({
      name: 'Acme',
      identifiers: [
        { type: 'social', value: 'https://www.linkedin.com/company/Acme/' },
        { type: 'social', value: 'https://m.facebook.com/AcmeCo/' },
        { type: 'social', value: 'https://www.linkedin.com/in/acme-founder' },
        { type: 'social', value: 'https://www.facebook.com/sharer/sharer.php?u=https://acme.sa' },
      ],
      source: { type: 'api', ref: 'a' },
    });

    const [source] = await withTenant(
      TENANT_A,
      (tx) => tx<{ data: { rejected?: { reason: string }[] } }[]>`
        select data from company_sources where company_id = ${created.company.id}
      `,
    );
    expect(source!.data.rejected?.map((r) => r.reason)).toEqual([
      'not a social profile',
      'not a social profile',
    ]);

    type Detail = {
      company: { id: string };
      identifiers: { type: string; value: string }[];
      socials: Record<string, string[]>;
    };
    const expected = {
      linkedin: ['https://linkedin.com/company/acme'],
      facebook: ['https://facebook.com/acmeco'],
    };

    for (const query of ['social:linkedin.com/company/acme', 'social:https://sa.linkedin.com/company/acme?trk=x']) {
      const res = await request(`/v1/companies?identifier=${encodeURIComponent(query)}`);
      expect(res.status).toBe(200);
      const detail = (await res.json()) as Detail;
      expect(detail.company.id).toBe(created.company.id);
      expect(detail.socials).toEqual(expected);
      expect(Object.keys(detail.socials)).toEqual(['linkedin', 'facebook']);
      expect(detail.identifiers.filter((i) => i.type === 'social').map((i) => i.value).sort()).toEqual([
        'facebook.com/acmeco',
        'linkedin.com/company/acme',
      ]);
    }

    const byId = await request(`/v1/companies/${created.company.id}`);
    expect(((await byId.json()) as Detail).socials).toEqual(expected);

    const person = await request('/v1/companies?identifier=social:linkedin.com/in/acme-founder');
    expect(person.status).toBe(404);
  });
});

describe('tenant scoping', () => {
  it('shares the company but not what each tenant says about it', async () => {
    const created = await postCompany({
      name: 'Shared Co',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'api', ref: 'a' },
      tenantView: { relationship: 'prospect', tags: ['vip'], notes: "A's note" },
    });

    // B sees the company itself.
    const forB = await request(`/v1/companies/${created.company.id}`, {}, tokenB);
    expect(forB.status).toBe(200);
    const detail = (await forB.json()) as {
      company: { id: string };
      tenantView: unknown;
      sources: unknown[];
    };
    expect(detail.company.id).toBe(created.company.id);

    // But not A's view of it, nor A's provenance.
    expect(detail.tenantView).toBeNull();
    expect(detail.sources).toHaveLength(0);
  });

  it("gives tenant B its own view rather than editing A's", async () => {
    const created = await postCompany({
      name: 'Shared Co',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'api', ref: 'a' },
      tenantView: { relationship: 'prospect', tags: ['vip'] },
    });

    const res = await request(
      `/v1/companies/${created.company.id}/view`,
      { method: 'PUT', ...json({ relationship: 'supplier', tags: ['mine'] }) },
      tokenB,
    );
    expect(res.status).toBe(200);

    const rows = await db()<{ tenant_id: string; relationship: string; tags: string[] }[]>`
      select tenant_id, relationship, tags from tenant_company
      where company_id = ${created.company.id} order by tenant_id
    `;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.tenant_id === TENANT_A)!.relationship).toBe('prospect');
    expect(rows.find((r) => r.tenant_id === TENANT_B)!.relationship).toBe('supplier');
  });
});

describe('lookup', () => {
  it('fills the name from the registrar and records a lookup source', async () => {
    setCompanyLookup(fakeLookup);
    seedFakeLookup(CR, { name: 'مؤسسة الفلاح التجارية', city: 'Riyadh', status: 'active' });

    const created = await postCompany({
      name: 'whatever the spreadsheet said',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'import', ref: 'file.csv:2' },
      enrich: true,
    });

    expect(created.company.name).toBe('مؤسسة الفلاح التجارية');

    const sources = await withTenant(
      TENANT_A,
      (tx) => tx<{ source_type: string; source_ref: string }[]>`
        select source_type, source_ref from company_sources
        where company_id = ${created.company.id} order by source_type
      `,
    );
    expect(sources.map((s) => s.source_type)).toEqual(['import', 'lookup']);
    expect(sources.find((s) => s.source_type === 'lookup')!.source_ref).toBe(`fake:${CR}`);
  });

  it('is a no-op when lookup is disabled', async () => {
    setCompanyLookup(null);

    const created = await postCompany({
      name: 'Unenriched Co',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'import', ref: 'file.csv:2' },
      enrich: true,
    });

    expect(created.company.name).toBe('Unenriched Co');
    const sources = await withTenant(
      TENANT_A,
      (tx) => tx<{ source_type: string }[]>`
        select source_type from company_sources where company_id = ${created.company.id}
      `,
    );
    expect(sources.map((s) => s.source_type)).toEqual(['import']);
  });
});

describe('messages learn the company', () => {
  async function configureMessaging() {
    await request('/v1/channels/sms', {
      method: 'PUT',
      ...json({
        provider: 'fake',
        sender: 'ACME',
        unsubscribeText: 'Reply STOP',
        config: { token: 'good' },
      }),
    });
    await request('/v1/templates/greet', {
      method: 'PUT',
      ...json({ channel: 'sms', body: 'Hi' }),
    });
  }

  it('stamps company_id when the address is a known identifier', async () => {
    await configureMessaging();
    const created = await postCompany({
      name: 'Known Co',
      identifiers: [{ type: 'phone', value: PHONE }],
      source: { type: 'api', ref: 'a' },
    });

    const known = await request('/v1/messages', {
      method: 'POST',
      ...json({
        contact: { phone: PHONE },
        channel: 'sms',
        purpose: 'transactional',
        template: 'greet',
      }),
    });
    expect(known.status).toBe(202);
    const { message } = (await known.json()) as { message: { id: string } };

    const [row] = await db()<{ company_id: string }[]>`
      select company_id from messages where id = ${message.id}
    `;
    expect(row!.company_id).toBe(created.company.id);

    const unknown = await request('/v1/messages', {
      method: 'POST',
      ...json({
        contact: { phone: '+966555000111' },
        channel: 'sms',
        purpose: 'transactional',
        template: 'greet',
      }),
    });
    const other = (await unknown.json()) as { message: { id: string } };
    const [otherRow] = await db()<{ company_id: string | null }[]>`
      select company_id from messages where id = ${other.message.id}
    `;
    expect(otherRow!.company_id).toBeNull();
  });
});

describe('csv import', () => {
  it('creates, links and reports rejected rows', async () => {
    const csv = [
      'name,country,cr,vat,domain,phone,email,relationship,tags',
      `Alpha Co,SA,${CR},,,,,customer,vip;gold`,
      `"Beta, Limited",SA,${OTHER_CR},,,,,,`,
      `Gamma Co,SA,${CR},,,,,supplier,`,
      'Delta Co,SA,,,delta.example,,,,',
      'Epsilon Co,SA,,,,notaphone,,,',
    ].join('\r\n');

    const res = await request('/v1/companies/import?ref=file.csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: csv,
    });
    expect(res.status).toBe(200);

    const summary = (await res.json()) as {
      rows: number;
      created: number;
      linked: number;
      rejected: { row: number; reason: string }[];
    };

    expect(summary.rows).toBe(5);
    // Alpha, Beta and Delta are new; Gamma shares Alpha's CR so it links.
    expect(summary.created).toBe(3);
    expect(summary.linked).toBe(1);

    // The quoted field kept its comma rather than splitting into two columns.
    const names = await db()<{ name: string }[]>`select name from companies order by name`;
    expect(names.map((n) => n.name)).toContain('Beta, Limited');

    // Epsilon offered only a phone, and it does not parse, so there is nothing
    // to match it on ever. Rejected, by the line number in the file.
    expect(summary.rejected).toEqual([{ row: 6, reason: 'not a valid phone number' }]);
  });

  it('refuses a file whose header is not the fixed one', async () => {
    const res = await request('/v1/companies/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: 'company,cr\nAlpha,1010',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('header must be exactly');
  });
});

describe('lookup by identifier', () => {
  it('finds a company by a normalised identifier', async () => {
    const created = await postCompany({
      name: 'Findable Co',
      identifiers: [{ type: 'cr', value: '1010-123456' }],
      source: { type: 'api', ref: 'a' },
    });

    const res = await request(`/v1/companies?identifier=cr:${CR}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { company: { id: string } };
    expect(detail.company.id).toBe(created.company.id);

    const missing = await request('/v1/companies?identifier=cr:9999999999');
    expect(missing.status).toBe(404);
  });
});
