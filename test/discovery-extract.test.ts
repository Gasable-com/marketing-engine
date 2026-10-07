import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { setFirecrawlFetch, setResolver, setTransport } from '../src/modules/discovery/read/index.js';
import { setProfile } from '../src/modules/discovery/index.js';
import { fakeLookup, resetFakeLookup, seedFakeLookup, setCompanyLookup, upsert } from '../src/spine/registry/index.js';
import { checkExtraction } from '../src/modules/discovery/extract/check.js';
import { FakeBridge, FakeSerper, clearProviders, drive, ok, setProviders, terms, type BridgeAnswer } from './fake-bridge.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb } from './helpers.js';

const app = createApp();
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN!;
const page = (name: string) => readFileSync(new URL(`./fixtures/pages/${name}`, import.meta.url));

/** The web, as far as these tests know it: host + path to a saved page. */
const SITES: Record<string, Buffer> = {
  'www.alfa-diesel.com.sa/en/': page('alfa-home.html'),
  'www.alfa-diesel.com.sa/en/products/': page('alfa-products.html'),
  'gulf-fuel.com/about': page('gulf-about.html'),
  'najm-fuel.com/': page('najm-home.html'),
  'desertfuel.sa/': page('desert-home.html'),
  'binareadymix.com/': page('binareadymix-home.html'),
};

let fetched: { url: string; address: string }[] = [];
let addresses: Record<string, string> = {};

const DIESEL = {
  name: 'Diesel fuel', nameAr: 'ديزل', brand: null, model: null, category: 'Fuels',
  aliases: ['diesel', 'ديزل'], description: 'Diesel fuel.', uses: ['generators'], notIdentified: false,
};
const DIESEL_PERSONAS = {
  personas: [
    {
      name: 'Diesel distributors', description: 'Sell diesel in bulk.', roles: ['distributor'], sectors: ['fuel'],
      searchTerms: terms('diesel fuel supplier', 'توريد ديزل'), placesTerms: terms('diesel supplier'),
      signals: ['bulk diesel delivery', 'serves factories'],
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

/** Keep every company the search turned up, except news. */
function triage(input: Record<string, unknown>) {
  const personas = input['personas'] as { id: string }[];
  const candidates = input['candidates'] as { id: string; name: string; snippets: { title: string }[] }[];
  return {
    verdicts: candidates.map((c) =>
      /news|grows|prices rise|directory/i.test(`${c.name} ${c.snippets.map((s) => s.title).join(' ')}`)
        ? { id: c.id, verdict: 'drop', fit: null, personaIds: [], reason: 'news or directory' }
        : { id: c.id, verdict: 'keep', fit: 'strong', personaIds: [personas[0]!.id], reason: 'supplier' },
    ),
  };
}

type Page = { url: string; text: string };
const q = (value: string, quote: string, url: string) => ({ value, quote, url });

/** What a careful reader would extract, quoting the pages it was given. */
function extract(input: Record<string, unknown>, tweak: (host: string, answer: Record<string, unknown>) => void = () => {}) {
  const pages = (input['pages'] as Page[]) ?? [];
  const listing = input['listing'] as { url: string; title: string } | null;
  const personaId = (input['personas'] as { id: string }[])[0]!.id;
  const home = pages[0];
  const host = home ? new URL(home.url).hostname.replace(/^www\./, '') : `maps:${listing?.title}`;
  const base = { isCompany: true, nameAr: null, personaId, fit: 'strong', roles: ['distributor'], cities: [] as unknown[], reason: 'diesel supplier' };

  let answer: Record<string, unknown>;
  switch (host) {
    case 'alfa-diesel.com.sa':
      answer = {
        ...base,
        name: q('Alfa Diesel Supply', 'Alfa Diesel Supply Company', home!.url),
        products: [q('bulk diesel delivery', 'We supply bulk diesel delivery to factories', home!.url)],
        cities: [q('Riyadh', 'to factories in Riyadh and the Eastern Province', home!.url)],
        evidence: [
          { signal: 0, claim: 'delivers diesel in bulk', quote: 'We supply bulk diesel delivery', url: home!.url },
          { signal: 1, claim: 'serves factories', quote: 'bulk diesel delivery to factories in Riyadh', url: home!.url },
        ],
      };
      break;
    case 'gulf-fuel.com':
      answer = {
        ...base,
        roles: ['wholesaler', 'importer'],
        name: q('Gulf Fuel Trading Co.', 'Gulf Fuel Trading Co. is a wholesale diesel', home!.url),
        products: [q('diesel and fuel oil', 'wholesale diesel and fuel oil distributor', home!.url)],
        evidence: [
          { signal: 0, claim: 'wholesale diesel', quote: 'a wholesale diesel and fuel oil distributor', url: home!.url },
          // Made up: no page says this.
          { signal: 1, claim: 'largest importer', quote: 'We are the largest diesel importer in Asia', url: home!.url },
        ],
      };
      break;
    case 'najm-fuel.com':
      answer = {
        ...base,
        name: q('نجم للمحروقات', 'شركة نجم للمحروقات متخصصة', home!.url),
        products: [q('توريد الديزل', 'متخصصة في توريد الديزل للمصانع', home!.url)],
        evidence: [{ signal: 1, claim: 'supplies factories', quote: 'توريد الديزل للمصانع والمقاولين', url: home!.url }],
      };
      break;
    case 'desertfuel.sa':
      answer = {
        ...base,
        name: q('Desert Fuel Est.', 'Desert Fuel Est. supplies diesel', home!.url),
        products: [q('diesel', 'supplies diesel to farms and factories', home!.url)],
        evidence: [],
      };
      break;
    case 'binareadymix.com':
      answer = {
        ...base,
        roles: ['manufacturer'],
        name: q('Bina ReadyMix', 'Bina ReadyMix produces high strength concrete', home!.url),
        products: [q('ready-mix concrete', 'produces high strength concrete with special mix designs', home!.url)],
        evidence: [{ signal: 0, claim: 'high-strength mixes', quote: 'high strength concrete with special mix designs', url: home!.url }],
      };
      break;
    default:
      // Maps-only listings.
      answer =
        listing && /Riyadh Diesel Station|Desert Fuel/.test(listing.title)
          ? { ...base, fit: 'weak', name: q(listing.title, listing.title, listing.url), products: [], evidence: [] }
          : { ...base, isCompany: false, fit: 'none', personaId: null, name: null, products: [], evidence: [], reason: 'an Instagram shop, not a company site' };
  }
  tweak(host, answer);
  return answer;
}

let extractTweak: (host: string, answer: Record<string, unknown>) => void = () => {};
let extractFail: (host: string, n: number) => BridgeAnswer | null = () => null;

function plan(identified: unknown, personas: unknown) {
  bridge.handler = (task, input, n) => {
    if (task === 'identify') return ok(identified);
    if (task === 'personas') return ok(personas);
    if (task === 'triage') return ok(triage(input));
    if (task === 'extract') {
      const pages = (input['pages'] as Page[]) ?? [];
      const host = pages[0] ? new URL(pages[0].url).hostname.replace(/^www\./, '') : 'maps';
      return extractFail(host, n) ?? ok(extract(input, extractTweak));
    }
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

type Result = {
  rank: number;
  tier: string;
  fit: string | null;
  persona: { name: string } | null;
  reasons: string[];
  evidence: { claim: string; quote: string; url: string }[];
  company: { id: string; name: string };
  profile: { products: string[]; quality: string | null; countries?: string[] } | null;
  identifiers: { type: string; value: string }[];
};

async function search(body: Record<string, unknown>) {
  const created = await call<{ job: { id: string } }>('POST', '/internal/discovery/jobs', { tenantId: TENANT_A, countries: ['SA'], ...body });
  expect(created.status).toBe(201);
  await drive();
  const jobId = created.body.job.id;
  const detail = await call<{ tasks: { status: string; error: string | null; counts: Record<string, number> }[] }>('GET', `/internal/discovery/jobs/${jobId}`);
  const results = await call<{ items: Result[] }>('GET', `/internal/discovery/jobs/${jobId}/results?limit=100`);
  const candidates = await call<{ items: { domain: string | null; gmaps: string | null; status: string; reason: string | null }[] }>(
    'GET',
    `/internal/discovery/jobs/${jobId}/candidates?limit=500`,
  );
  return { jobId, detail: detail.body, results: results.body.items, candidates: candidates.body.items };
}

const named = (results: Result[], name: string) => results.find((r) => r.company.name === name);

beforeAll(async () => {
  await bridge.start();
  await resetDb();
  await startQueue();
});

afterAll(async () => {
  clearProviders();
  setTransport(null);
  setResolver(null);
  setFirecrawlFetch(null);
  setCompanyLookup(undefined);
  await bridge.stop();
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  setCompanyLookup(null);
  bridge.calls = [];
  serper.calls = [];
  fetched = [];
  addresses = {};
  extractTweak = () => {};
  extractFail = () => null;
  clearProviders();
  setProviders({ bridge: bridge.url(), serper: true });
  serper.install();
  plan(DIESEL, DIESEL_PERSONAS);
  setResolver(async (host) => [addresses[host] ?? '93.184.216.34']);
  setTransport(async ({ url, address }) => {
    fetched.push({ url, address });
    const u = new URL(url);
    const body = SITES[`${u.host}${u.pathname}`];
    return body
      ? { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body }
      : { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<p>not found</p>') };
  });
});

describe('read, extract, save, rank', () => {
  it('saves the suppliers an empty pool search finds, with checked quotes, and ranks them', async () => {
    const { results, detail } = await search({ product: 'diesel', side: 'suppliers' });
    expect(detail.tasks[0]).toMatchObject({ status: 'done' });

    const alfa = named(results, 'Alfa Diesel Supply')!;
    expect(alfa).toMatchObject({ tier: 'found', fit: 'strong', persona: { name: 'Diesel distributors' } });
    expect(alfa.reasons[0]).toBe('persona: Diesel distributors');
    expect(alfa.evidence.map((e) => e.quote)).toEqual([
      'We supply bulk diesel delivery',
      'bulk diesel delivery to factories in Riyadh',
    ]);
    expect(alfa.profile).toMatchObject({ products: ['bulk diesel delivery'], quality: 'full' });
    expect(alfa.identifiers).toEqual(
      expect.arrayContaining([
        { type: 'domain', value: 'alfa-diesel.com.sa' },
        { type: 'phone', value: '+966501111111' },
        { type: 'email', value: 'sales@alfa-diesel.com.sa' },
      ]),
    );
    for (const name of ['Gulf Fuel Trading Co.', 'نجم للمحروقات', 'Desert Fuel Est.']) {
      expect(named(results, name), name).toMatchObject({ tier: 'found' });
    }
    // Both signals shown beats one: Alfa ranks first.
    expect(results[0]!.company.name).toBe('Alfa Diesel Supply');

    const [source] = await db()<{ source_type: string; tenant_id: string; data: Record<string, unknown> }[]>`
      select source_type, tenant_id::text, data from company_sources where company_id = ${alfa.company.id}
    `;
    expect(source).toMatchObject({ source_type: 'web', tenant_id: TENANT_A });
    // The CR on the page is claimed, not trusted: it is not an identifier.
    expect(source!.data['crClaimed']).toBe('1010123456');
    expect(alfa.identifiers.some((i) => i.type === 'cr')).toBe(false);

    const counts = detail.tasks[0]!.counts;
    expect(counts).toMatchObject({ saved: 5, quotes_dropped: 1 });
    expect(counts['not_saved']).toBe(1);
  });

  it('drops a made-up quote, a page nobody read, a javascript: url and an unknown persona', async () => {
    extractTweak = (host, answer) => {
      if (host === 'desertfuel.sa') {
        (answer['products'] as unknown[]).push(
          q('crude oil', 'We also refine crude oil at sea', 'https://desertfuel.sa/'),
          q('jet fuel', 'Desert Fuel Est. supplies diesel', 'https://evil.example/page'),
          q('lpg', 'Desert Fuel Est. supplies diesel', 'javascript:alert(1)'),
        );
      }
      if (host === 'najm-fuel.com') answer['personaId'] = '00000000-0000-0000-0000-000000000000';
    };
    const { results, candidates } = await search({ product: 'diesel', side: 'suppliers' });
    expect(named(results, 'Desert Fuel Est.')!.profile!.products).toEqual(['diesel']);
    expect(named(results, 'نجم للمحروقات')).toBeUndefined();
    expect(candidates.find((c) => c.domain === 'najm-fuel.com')).toMatchObject({ status: 'not_saved', reason: 'unknown persona' });
    const gulf = named(results, 'Gulf Fuel Trading Co.')!;
    expect(gulf.evidence.map((e) => e.claim)).toEqual(['wholesale diesel']);
    // Roles outside the list ("importer") are dropped, the rest kept.
    const [profile] = await db()<{ roles: string[] }[]>`select roles from company_profiles where company_id = ${gulf.company.id}`;
    expect(profile!.roles).toEqual(['wholesaler']);
  });

  it('saves a Maps-only company with its phone and Maps id', async () => {
    const { results } = await search({ product: 'diesel', side: 'suppliers' });
    const station = named(results, 'Riyadh Diesel Station')!;
    expect(station).toMatchObject({ tier: 'found', fit: 'weak', profile: { quality: 'thin' } });
    expect(station.identifiers).toEqual(
      expect.arrayContaining([
        { type: 'gmaps', value: '2220000000000000002' },
        { type: 'phone', value: '+966552222222' },
      ]),
    );
    const [source] = await db()<{ source_type: string }[]>`select source_type from company_sources where company_id = ${station.company.id}`;
    expect(source!.source_type).toBe('maps');
  });

  it('does not re-read a company profiled from the web within 90 days, and re-reads an older one', async () => {
    const add = async (domain: string, name: string, daysAgo: number) => {
      const { company } = await withTenant(TENANT_A, (tx) =>
        upsert(tx, { name, country: 'SA', identifiers: [{ type: 'domain', value: domain }], source: { type: 'api', tenantId: TENANT_A } }),
      );
      await withTenant(TENANT_A, (tx) =>
        setProfile(tx, { tenantId: TENANT_A, companyId: company.id, products: ['diesel'], quality: 'full', profiledAt: new Date(Date.now() - daysAgo * 86_400_000) }),
      );
    };
    await add('alfa-diesel.com.sa', 'Alfa Diesel Supply', 30);
    await add('gulf-fuel.com', 'Gulf Fuel Trading Co.', 120);

    const { detail, results } = await search({ product: 'diesel', side: 'suppliers' });
    expect(fetched.some((f) => f.url.includes('alfa-diesel'))).toBe(false);
    expect(fetched.some((f) => f.url.includes('gulf-fuel'))).toBe(true);
    expect(detail.tasks[0]!.counts).toMatchObject({ read_skipped_fresh: 1 });
    expect(named(results, 'Alfa Diesel Supply')!.reasons).toContain('strong fit from search results');
  });

  it('ranks a buyers search’s ready-mix plant above a pool company matched only by a Maps keyword, and lists no seller', async () => {
    plan(
      { ...DIESEL, name: 'Microsilica', aliases: ['microsilica'] },
      {
        personas: [
          {
            name: 'Ready-mix concrete plants', description: 'Add it to high-strength mixes.', roles: ['manufacturer'],
            sectors: ['construction'], searchTerms: terms('ready mix concrete company'), placesTerms: terms('ready mix concrete'),
            signals: ['high strength concrete'],
          },
        ],
      },
    );
    const pool = async (name: string, products: string[]) => {
      const { company } = await withTenant(TENANT_A, (tx) =>
        upsert(tx, { name, country: 'SA', identifiers: [], source: { type: 'api', tenantId: TENANT_A } }),
      );
      await withTenant(TENANT_A, (tx) => setProfile(tx, { tenantId: TENANT_A, companyId: company.id, products }));
    };
    await pool('Eastern Ready Mix Concrete', ['Ready mix concrete C40']);
    await pool('Silica Sellers', ['Microsilica', 'Silica fume']);

    const { results } = await search({ product: 'Microsilica MS900D  1 MT', side: 'buyers' });
    expect(results.map((r) => [r.company.name, r.tier])).toEqual([
      ['Bina ReadyMix', 'found'],
      ['Eastern Ready Mix Concrete', 'pool'],
    ]);
    expect(results[0]!.evidence[0]!.quote).toBe('high strength concrete with special mix designs');
  });

  it('resumes after a usage limit at the candidate it stopped on, and survives one failed extraction', async () => {
    let extracts = 0;
    extractFail = (host) => {
      extracts += 1;
      if (extracts === 3) return { status: 429, body: { error: 'usage_limit', resetsAt: null } };
      if (host === 'gulf-fuel.com') return { status: 504, body: { error: 'claude_failed', reason: 'timeout' } };
      return null;
    };
    const { detail, results, candidates } = await search({ product: 'diesel', side: 'suppliers' });
    expect(detail.tasks[0]).toMatchObject({ status: 'done' });
    expect(candidates.find((c) => c.domain === 'gulf-fuel.com')).toMatchObject({ status: 'failed' });
    expect(results.filter((r) => r.tier === 'found').length).toBe(4);
    // Six kept candidates, one of them asked twice (the deferral), none re-extracted after it.
    expect(extracts).toBe(7);
  });

  it('never connects to a private address', async () => {
    addresses['najm-fuel.com'] = '172.18.0.1';
    const { candidates } = await search({ product: 'diesel', side: 'suppliers' });
    expect(fetched.some((f) => f.url.includes('najm-fuel'))).toBe(false);
    expect(fetched.every((f) => f.address === '93.184.216.34')).toBe(true);
    expect(candidates.find((c) => c.domain === 'najm-fuel.com')!.status).toBe('failed');
  });

  it('never lets a page’s CR or a name merge it into a pool company', async () => {
    const { company: real } = await withTenant(TENANT_A, (tx) =>
      upsert(tx, {
        name: 'Gulf Fuel Trading Co.',
        country: 'SA',
        identifiers: [{ type: 'cr', value: '1010123456' }, { type: 'domain', value: 'realgulf.com' }],
        source: { type: 'api', tenantId: TENANT_A },
      }),
    );
    const { results } = await search({ product: 'diesel', side: 'suppliers' });
    // Alfa's page prints the real company's CR; Gulf Fuel's page carries its exact name under another domain.
    expect(named(results, 'Alfa Diesel Supply')!.company.id).not.toBe(real.id);
    const gulf = results.filter((r) => r.company.name === 'Gulf Fuel Trading Co.' && r.tier === 'found');
    expect(gulf).toHaveLength(1);
    expect(gulf[0]!.company.id).not.toBe(real.id);
    const ids = await db()<{ type: string; value: string }[]>`
      select type, value from company_identifiers where company_id = ${real.id} order by type
    `;
    expect(ids).toEqual([{ type: 'cr', value: '1010123456' }, { type: 'domain', value: 'realgulf.com' }]);
  });

  it('takes only emails on the company’s own domain, so a printed partner address merges nothing', async () => {
    const { results } = await search({ product: 'diesel', side: 'suppliers' });
    const gulf = named(results, 'Gulf Fuel Trading Co.')!;
    const alfa = named(results, 'Alfa Diesel Supply')!;
    // Gulf Fuel's page prints Alfa's address and its web agency's: neither is Gulf Fuel's.
    expect(gulf.company.id).not.toBe(alfa.company.id);
    expect(gulf.identifiers.filter((i) => i.type === 'email' || i.type === 'domain')).toEqual([{ type: 'domain', value: 'gulf-fuel.com' }]);
    const [row] = await db()<{ n: number }[]>`select count(*)::int as n from company_identifiers where value = 'nileweb.example'`;
    expect(row!.n).toBe(0);
  });

  it('judges a listing whose website cannot be read as the listing alone, claiming no domain', async () => {
    delete SITES['desertfuel.sa/'];
    try {
      const { results } = await search({ product: 'diesel', side: 'suppliers' });
      const desert = named(results, 'Desert Fuel')!;
      expect(desert).toMatchObject({ tier: 'found' });
      expect(desert.identifiers.some((i) => i.type === 'domain')).toBe(false);
      expect(desert.identifiers).toContainEqual({ type: 'gmaps', value: '5550000000000000005' });
      const [source] = await db()<{ source_type: string }[]>`select source_type from company_sources where company_id = ${desert.company.id}`;
      expect(source!.source_type).toBe('maps');
    } finally {
      SITES['desertfuel.sa/'] = page('desert-home.html');
    }
  });

  it('keeps a listing’s Maps id off a company whose website the listing merely named', async () => {
    const { results } = await search({ product: 'diesel', side: 'suppliers' });
    const alfa = named(results, 'Alfa Diesel Supply')!;
    // The listing that named alfa-diesel.com.sa as its site is titled differently.
    expect(alfa.identifiers.some((i) => i.type === 'gmaps')).toBe(false);
    const [source] = await db()<{ data: Record<string, unknown> }[]>`select data from company_sources where company_id = ${alfa.company.id}`;
    expect(source!.data['listingCid']).toBe('1110000000000000001');
  });

  it('trusts a page’s CR only when the registrar gives the same name', async () => {
    setCompanyLookup(fakeLookup);
    resetFakeLookup();
    seedFakeLookup('1010123456', { name: 'Alfa Diesel Supply' });
    try {
      const { results } = await search({ product: 'diesel', side: 'suppliers' });
      const alfa = named(results, 'Alfa Diesel Supply')!;
      const crs = await db()<{ value: string }[]>`select value from company_identifiers where company_id = ${alfa.company.id} and type = 'cr'`;
      expect(crs).toEqual([{ value: '1010123456' }]);
    } finally {
      resetFakeLookup();
      setCompanyLookup(null);
    }
  });

  it('merges what an SA and an AE search say about one company, and never lowers its quality', async () => {
    await search({ product: 'diesel', side: 'suppliers' });
    extractTweak = (host, answer) => {
      if (host === 'alfa-diesel.com.sa') answer['products'] = [q('fuel tank rental', 'Fuel tank rental for construction sites', 'https://www.alfa-diesel.com.sa/en/products/')];
    };
    await db()`truncate search_queries`;
    const [row] = await db()<{ id: string }[]>`select company_id::text as id from company_identifiers where value = 'alfa-diesel.com.sa'`;
    const id = row!.id;
    await db()`update company_profiles set profiled_at = now() - interval '100 days' where company_id = ${id}`;
    await search({ product: 'diesel', side: 'suppliers', countries: ['AE'] });
    const [profile] = await db()<{ products: string[]; countries: string[]; quality: string }[]>`
      select products, countries, quality from company_profiles where company_id = ${id}
    `;
    expect(profile!.countries).toEqual(['SA', 'AE']);
    expect(profile!.products).toEqual(['bulk diesel delivery', 'fuel tank rental']);
    expect(profile!.quality).toBe('full');
  });

  it('keeps page text out of every stored row, event and error', async () => {
    const { jobId } = await search({ product: 'diesel', side: 'suppliers' });
    const marker = 'PAGE-ONLY-MARKER';
    const dumps = await Promise.all([
      db()`select data::text as t from company_sources`,
      db()`select reasons::text || evidence::text as t from discovery_results where job_id = ${jobId}`,
      db()`select coalesce(error, '') || counts::text as t from discovery_tasks where job_id = ${jobId}`,
      db()`select coalesce(error, '') as t from discovery_jobs where id = ${jobId}`,
      db()`select payload::text as t from events`,
      db()`select evidence::text || coalesce(reason, '') as t from discovery_candidates where job_id = ${jobId}`,
    ]);
    for (const rows of dumps) for (const row of rows) expect(String(row['t'])).not.toContain(marker);
  });

  it('exports the results as a CSV the operator can download', async () => {
    extractTweak = (host, answer) => {
      // A page that tries to smuggle a spreadsheet formula into a cell.
      if (host === 'desertfuel.sa') {
        answer['products'] = [q('=HYPERLINK("http://evil.test","click")', 'Desert Fuel Est. supplies diesel', 'https://desertfuel.sa/')];
      }
    };
    const { jobId, results } = await search({ product: 'diesel', side: 'suppliers' });
    const res = await app.fetch(
      new Request(`http://engine.test/internal/discovery/jobs/${jobId}/results.csv?country=SA`, {
        headers: { 'X-Internal-Token': INTERNAL_TOKEN },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="discovery-diesel-fuel-suppliers-SA-\d{4}-\d{2}-\d{2}\.csv"/);

    const raw = new Uint8Array(await res.arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(raw.slice(3));
    const lines = text.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'rank,country,tier,score,company,company_id,persona,fit,domains,phones,emails,google_maps_ids,products,roles,cities,profile_quality,profiled_at,evidence,reasons',
    );
    expect(lines).toHaveLength(results.length + 1);
    expect(lines[1]).toMatch(/^1,SA,found,/);
    expect(text).toContain('نجم للمحروقات');
    expect(text).toContain(',+966501111111,');
    expect(text).toContain('"\'=HYPERLINK(""http://evil.test"",""click"")"');

    const missing = await app.fetch(
      new Request('http://engine.test/internal/discovery/jobs/44444444-4444-4444-4444-444444444444/results.csv', {
        headers: { 'X-Internal-Token': INTERNAL_TOKEN },
      }),
    );
    expect(missing.status).toBe(404);
  });

  it('keeps one tenant’s web provenance from another', async () => {
    await search({ product: 'diesel', side: 'suppliers' });
    const seen = (tenantId: string) =>
      withTenant(tenantId, (tx) => tx`select id from company_sources where source_type in ('web', 'maps')`);
    expect((await seen(TENANT_A)).length).toBeGreaterThan(0);
    expect(await seen(TENANT_B)).toHaveLength(0);
  });

  it('falls back to a plain fetch when Firecrawl fails, and uses Firecrawl when it answers', async () => {
    process.env.FIRECRAWL_URL = 'http://firecrawl.test';
    setProviders({ bridge: bridge.url(), serper: true });
    let scrapes = 0;
    setFirecrawlFetch(async (_url, init) => {
      scrapes += 1;
      const { url } = JSON.parse(String(init?.body)) as { url: string };
      if (url.includes('gulf-fuel')) return new Response('{"success":false}', { status: 500 });
      const u = new URL(url);
      const html = SITES[`${u.host}${u.pathname}`];
      if (!html) return new Response('{"success":false}', { status: 404 });
      const text = html.toString().replace(/<[^>]+>/g, ' ');
      return new Response(JSON.stringify({ success: true, data: { markdown: text, links: [], metadata: { url, sourceURL: url, statusCode: 200 } } }), { status: 200 });
    });
    const { detail, results } = await search({ product: 'diesel', side: 'suppliers' });
    expect(scrapes).toBeGreaterThan(0);
    expect(detail.tasks[0]!.counts['firecrawl']).toBeGreaterThan(0);
    expect(detail.tasks[0]!.counts['fetch_fallback']).toBeGreaterThan(0);
    expect(named(results, 'Gulf Fuel Trading Co.')).toMatchObject({ tier: 'found' });
    setFirecrawlFetch(null);
  });
});

describe('checking quotes', () => {
  const persona = { id: 'p1', signals: ['bulk diesel delivery'] };
  const sources = [{ url: 'https://x.test/', text: 'Alfa Diesel Supply Company delivers bulk diesel to factories in Riyadh.' }];
  const answer = (over: Record<string, unknown> = {}) =>
    ({
      isCompany: true, personaId: 'p1', fit: 'strong', roles: [], cities: [], reason: 'ok', nameAr: null,
      name: { value: 'Alfa Diesel Supply', quote: 'Alfa Diesel Supply Company', url: 'https://x.test/' },
      products: [], evidence: [], ...over,
    }) as Parameters<typeof checkExtraction>[0];

  it('drops a scrap padded to length, a quote longer than a sentence or two, and part of a word', () => {
    const result = checkExtraction(
      answer({
        evidence: [
          { signal: 0, claim: 'pad', quote: '..........re', url: 'https://x.test/' },
          { signal: 0, claim: 'long', quote: 'x'.repeat(301), url: 'https://x.test/' },
          { signal: 0, claim: 'part', quote: 'esel Supply Comp', url: 'https://x.test/' },
          { signal: 0, claim: 'real', quote: 'delivers bulk diesel to factories', url: 'https://x.test/' },
        ],
      }),
      { sources, personas: [persona] },
    );
    expect(result.saved && result.evidence.map((e) => e.claim)).toEqual(['real']);
    expect(result.quotesDropped).toBe(3);
  });

  it('refuses a name that folds to nothing, and saves a Maps listing under its own title', () => {
    expect(checkExtraction(answer({ name: { value: 'Trading Co.', quote: 'Alfa Diesel Supply Company', url: 'https://x.test/' } }), { sources, personas: [persona] }))
      .toMatchObject({ saved: false, reason: 'no checked name' });

    const listing = { url: 'https://maps.google.com/?cid=1', text: 'Falah Ready Mix\nRiyadh' };
    const result = checkExtraction(
      answer({ name: { value: 'falah ready mix', quote: 'invented quote, official supplier', url: 'https://evil.test/' } }),
      { sources: [listing], personas: [persona], listingTitle: 'Falah Ready Mix', listingUrl: listing.url },
    );
    expect(result).toMatchObject({ saved: true, name: { value: 'Falah Ready Mix', quote: 'Falah Ready Mix', url: listing.url } });
    // A longer, embellished name is not the listing's.
    expect(
      checkExtraction(answer({ name: { value: 'Falah Ready Mix - official Aramco supplier', quote: 'x', url: 'https://evil.test/' } }), {
        sources: [listing], personas: [persona], listingTitle: 'Falah Ready Mix', listingUrl: listing.url,
      }),
    ).toMatchObject({ saved: false });
  });
});
