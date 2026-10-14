import { Hono } from 'hono';
import { z } from 'zod';
import { db, withTenant } from '../../../db/client.js';
import {
  CountrySettingsInput,
  MAX_COUNTRIES,
  MAX_RESULT_LIMIT,
  MAX_RFQ_LINES,
  createRfqSearch,
  MAX_SOURCE_ROW,
  countryCode,
  listCountrySettings,
  saveCountrySettings,
  Identified,
  createJob,
  didYouMeanFor,
  identifyProduct,
  readRow,
} from '../../../modules/discovery/index.js';
import { QUERIED_EVENT } from '../../../modules/discovery/index.js';
import { queries, spendColumns, spendOf, spendOfJob, type SpendRow } from './search-spend.js';
import { listQuery, page, resolveWindow, windowQuery } from './shared.js';

/**
 * Discovery jobs for the operator: create a search for a tenant, and read
 * jobs, their tasks and their ranked results across every tenant. Everything
 * the review screen shows is in these responses; the dashboard works nothing
 * out for itself.
 */
export const discoveryOperator = new Hono();

const createBody = z.object({
  tenantId: z.string().uuid(),
  product: z.string().trim().min(2).max(200),
  category: z.string().trim().max(200).optional(),
  countries: z
    .array(countryCode)
    .min(1)
    .max(MAX_COUNTRIES)
    .refine((list) => new Set(list).size === list.length, 'each country once'),
  resultLimit: z.number().int().min(1).max(MAX_RESULT_LIMIT).optional(),
  side: z.enum(['suppliers', 'buyers']).default('suppliers'),
  row: z.string().max(MAX_SOURCE_ROW).optional(),
  /** The identification accepted from POST /internal/discovery/identify. */
  identified: Identified.optional(),
  /** The operator confirmed `product` (picked a "did you mean", or chose "as typed"). */
  confirmed: z.boolean().optional(),
});

/**
 * How each country is searched: its discovery.country row, seeded, made by
 * Claude the first time a job searched it, or set here. Saving replaces the
 * row whole, and the next job in that country searches with it.
 */
discoveryOperator.get('/internal/discovery/countries', async (c) => {
  const items = await db().begin((tx) => listCountrySettings(tx));
  return c.json({ items });
});

discoveryOperator.post('/internal/discovery/countries/:code', async (c) => {
  const code = countryCode.safeParse(c.req.param('code'));
  if (!code.success) return c.json({ error: 'invalid country', detail: code.error.issues }, 400);
  // A timezone matters only for a country never searched: it becomes the region's.
  const body = z
    .object({ settings: CountrySettingsInput, timezone: z.string().max(64).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid body', detail: body.error.issues }, 400);

  const items = await db().begin(async (tx) => {
    await saveCountrySettings(tx, code.data, body.data.settings, {
      by: 'operator',
      replace: true,
      timezone: body.data.timezone,
    });
    return listCountrySettings(tx);
  });
  return c.json({ country: items.find((i) => i.code === code.data) });
});

discoveryOperator.post('/internal/discovery/jobs', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const { tenantId, ...input } = parsed.data;
  const [tenant] = await db()`select id from tenants where id = ${tenantId}`;
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);

  const created = await withTenant(tenantId, (tx) => createJob(tx, { tenantId, ...input }));
  return c.json((await oneJob(created.job.id))!, 201);
});

/**
 * What a pasted table row says the product is, before a job is created from
 * it, so the operator can see and correct the reading.
 */
discoveryOperator.post('/internal/discovery/read-row', async (c) => {
  const parsed = z
    .object({ row: z.string().min(1).max(5000) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const reading = readRow(parsed.data.row);
  if (!reading) {
    return c.json({ error: 'no_product', message: 'no cell in that row reads as a product name' }, 400);
  }
  return c.json(reading);
});

discoveryOperator.get('/internal/discovery/jobs', async (c) => {
  const q = listQuery
    .extend({
      cursor: z.string().uuid().optional(),
      tenantId: z.string().uuid().optional(),
      status: z.enum(['planning', 'running', 'done', 'failed']).optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const sql = db();
  const rows = await sql<(Record<string, unknown> & SpendRow)[]>`
    select j.id::text as id, j.tenant_id::text as "tenantId", t.name as "tenantName",
           j.product, j.category, j.side, j.countries, j.status, j.counts,
           j.identified->>'name' as "identifiedName",
           j.rfq_search_id::text as "rfqSearchId", j.requester_ref as "requesterRef",
           j.created_at as "createdAt", j.finished_at as "finishedAt",
           s.queries, s.serper_calls, s.cache_hits, s.credits
    from discovery_jobs j
    join tenants t on t.id = j.tenant_id
    left join lateral (
      select ${spendColumns()}
      from events e
      where e.tenant_id = j.tenant_id and e.type = ${QUERIED_EVENT} and e.subject_id = j.id::text
    ) s on true
    where true
      ${q.data.tenantId ? sql`and j.tenant_id = ${q.data.tenantId}` : sql``}
      ${q.data.status ? sql`and j.status = ${q.data.status}` : sql``}
      ${q.data.cursor ? sql`and (j.created_at, j.id) < (select created_at, id from discovery_jobs where id = ${q.data.cursor})` : sql``}
    order by j.created_at desc, j.id desc
    limit ${q.data.limit}
  `;
  const items = rows.map(({ queries: n, serper_calls, cache_hits, credits, ...row }) => ({
    ...row,
    spend: spendOf({ queries: n, serper_calls, cache_hits, credits }),
  }));
  return c.json(page(items, q.data.limit));
});

/**
 * Every query the searches made, newest first, each priced: the log the
 * spend figures are summed from. A job's history is bounded by the job, so
 * `jobId` ignores the window; without it the window applies, 7 days by default.
 */
discoveryOperator.get('/internal/discovery/queries', async (c) => {
  const q = listQuery
    .merge(windowQuery)
    .extend({
      cursor: z.string().regex(/^\d+$/).optional(),
      jobId: z.string().uuid().optional(),
      tenantId: z.string().uuid().optional(),
      country: countryCode.optional(),
      kind: z.enum(['web', 'places']).optional(),
      cached: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const window = q.data.jobId ? null : resolveWindow(q.data, '7d');
  const items = await queries({ ...q.data, window });
  return c.json(page(items, q.data.limit));
});

/**
 * What the product is, before a search is created: the "did you mean" step.
 * Nothing is stored. `identified` is null when the Claude bridge is not
 * configured, and the search goes ahead with the product as typed.
 */
discoveryOperator.post('/internal/discovery/identify', async (c) => {
  const parsed = z
    .object({
      product: z.string().trim().min(2).max(200),
      category: z.string().trim().max(200).optional(),
      row: z.string().max(MAX_SOURCE_ROW).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);
  const identified = await identifyProduct(parsed.data);
  const didYouMean = didYouMeanFor(parsed.data.product, identified);
  return c.json({ identified, didYouMean });
});

const rfqCreateBody = z.object({
  tenantId: z.string().uuid(),
  rfqRef: z.string().trim().min(1).max(200).optional(),
  side: z.enum(['suppliers', 'buyers']).default('suppliers'),
  countries: z
    .array(countryCode)
    .min(1)
    .max(MAX_COUNTRIES)
    .refine((list) => new Set(list).size === list.length, 'each country once'),
  resultLimit: z.number().int().min(1).max(MAX_RESULT_LIMIT).optional(),
  lines: z
    .array(
      z.object({
        lineRef: z.string().trim().min(1).max(200).optional(),
        product: z.string().trim().min(2).max(200),
        category: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(MAX_RFQ_LINES),
});

/** An RFQ search for a tenant: one product search per line. Operators are not limited. */
discoveryOperator.post('/internal/discovery/rfq-searches', async (c) => {
  const parsed = rfqCreateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);
  const { tenantId, ...input } = parsed.data;
  const [tenant] = await db()`select id from tenants where id = ${tenantId}`;
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);

  const created = await withTenant(tenantId, (tx) => createRfqSearch(tx, { tenantId, ...input }));
  return c.json((await oneRfqSearch(created.rfq.id))!, 201);
});

discoveryOperator.get('/internal/discovery/rfq-searches', async (c) => {
  const q = listQuery
    .extend({
      cursor: z.string().uuid().optional(),
      tenantId: z.string().uuid().optional(),
      status: z.enum(['running', 'done', 'failed']).optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const sql = db();
  const rows = await sql<Record<string, unknown>[]>`
    select q.id::text as id, q.tenant_id::text as "tenantId", t.name as "tenantName",
           q.rfq_ref as "rfqRef", q.requester_ref as "requesterRef", q.side, q.countries,
           q.status, q.counts, q.created_at as "createdAt", q.finished_at as "finishedAt",
           (select count(*)::int from discovery_jobs j where j.rfq_search_id = q.id) as "lineCount",
           (select coalesce(json_agg(j.product order by j.line_position), '[]'::json)
              from discovery_jobs j where j.rfq_search_id = q.id) as products
    from discovery_rfq_searches q
    join tenants t on t.id = q.tenant_id
    where true
      ${q.data.tenantId ? sql`and q.tenant_id = ${q.data.tenantId}` : sql``}
      ${q.data.status ? sql`and q.status = ${q.data.status}` : sql``}
      ${q.data.cursor ? sql`and (q.created_at, q.id) < (select created_at, id from discovery_rfq_searches where id = ${q.data.cursor})` : sql``}
    order by q.created_at desc, q.id desc
    limit ${q.data.limit}
  `;
  return c.json(page(rows, q.data.limit));
});

discoveryOperator.get('/internal/discovery/rfq-searches/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const detail = await oneRfqSearch(id.data);
  return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
});

/** An RFQ search with each line: its product search, status and counts, in line order. */
async function oneRfqSearch(id: string) {
  const sql = db();
  const [rfqSearch] = await sql<Record<string, unknown>[]>`
    select q.id::text as id, q.tenant_id::text as "tenantId", t.name as "tenantName",
           q.rfq_ref as "rfqRef", q.requester_ref as "requesterRef", q.side, q.countries,
           q.status, q.counts, q.created_at as "createdAt", q.finished_at as "finishedAt"
    from discovery_rfq_searches q
    join tenants t on t.id = q.tenant_id
    where q.id = ${id}
  `;
  if (!rfqSearch) return undefined;
  const lines = await sql<Record<string, unknown>[]>`
    select j.line_position as position, j.line_ref as "lineRef", j.id::text as "jobId",
           j.product, j.identified->>'name' as "identifiedName", j.status, j.counts, j.error,
           j.created_at as "createdAt", j.finished_at as "finishedAt"
    from discovery_jobs j
    where j.rfq_search_id = ${id}
    order by j.line_position
  `;
  return { rfqSearch, lines };
}

discoveryOperator.get('/internal/discovery/jobs/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const detail = await oneJob(id.data);
  return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
});

discoveryOperator.get('/internal/discovery/jobs/:id/results', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const q = listQuery
    .extend({ cursor: z.string().regex(/^\d+$/).optional(), country: countryCode.optional() })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const sql = db();
  const [job] = await sql`select id from discovery_jobs where id = ${id.data}`;
  if (!job) return c.json({ error: 'not found' }, 404);

  const rows = await resultRows(id.data, q.data);

  return c.json(
    page(
      rows.map((r) => ({
        id: r.id,
        rank: r.rank,
        score: r.score,
        reasons: r.reasons,
        country: r.country,
        tier: r.tier,
        persona: r.persona_id ? { id: r.persona_id, name: r.persona_name } : null,
        fit: r.fit,
        evidence: r.evidence.map((e) => ({ claim: e.claim, quote: e.quote, url: e.url })),
        company: { id: r.company_id, name: r.company_name, country: r.company_country },
        profile: r.has_profile
          ? {
              products: r.products,
              roles: r.roles,
              cities: r.cities,
              quality: r.quality,
              profiledAt: r.profiled_at,
            }
          : null,
        identifiers: r.identifiers,
      })),
      q.data.limit,
    ),
  );
});

/** A job's ranked results, rank order; both the page and the CSV read these. */
async function resultRows(
  jobId: string,
  opts: { country?: string | undefined; cursor?: string | undefined; limit: number },
): Promise<ResultRow[]> {
  const sql = db();
  return sql<ResultRow[]>`
    select r.id::text as id, r.rank, r.score, r.reasons, k.country, r.tier, r.fit, r.evidence,
           r.persona_id::text as persona_id, ps.name as persona_name,
           c.id::text as company_id, c.name as company_name, c.country as company_country,
           p.company_id is not null as has_profile, p.products, p.roles, p.cities,
           p.quality, p.profiled_at,
           coalesce((
             select json_agg(json_build_object('type', i.type, 'value', i.value)
                             order by i.type, i.value)
             from company_identifiers i
             where i.company_id = c.id and i.type in ('domain', 'phone', 'email', 'gmaps')
           ), '[]'::json) as identifiers
    from discovery_results r
    join discovery_tasks k on k.id = r.task_id
    join companies c on c.id = r.company_id
    left join company_profiles p on p.company_id = c.id
    left join discovery_personas ps on ps.id = r.persona_id
    where r.job_id = ${jobId}
      ${opts.country ? sql`and k.country = ${opts.country}` : sql``}
      ${opts.cursor ? sql`and (r.rank, r.id) > (select rank, id from discovery_results where id = ${opts.cursor})` : sql``}
    order by r.rank, r.id
    limit ${opts.limit}
  `;
}

/** At most this many rows in one CSV: every country of a job at the highest result limit. */
const CSV_MAX_ROWS = 2000;

const CSV_COLUMNS = [
  'rank', 'country', 'tier', 'score', 'company', 'company_id', 'persona', 'fit',
  'domains', 'phones', 'emails', 'google_maps_ids', 'products', 'roles', 'cities',
  'profile_quality', 'profiled_at', 'evidence', 'reasons',
] as const;

/**
 * One CSV cell, quoted when it must be. Free text came from web pages, so a
 * text cell a spreadsheet would read as a formula (=, +, -, @, tab, CR) gets
 * a leading apostrophe. Values the engine normalised itself (E.164 phones,
 * domains, ids, numbers) are written as they are.
 */
function csvCell(value: unknown, kind: 'text' | 'value' = 'text'): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (kind === 'text' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Which columns hold the engine's own normalised values rather than page text. */
const CSV_VALUE_COLUMNS = new Set([
  'rank', 'country', 'tier', 'score', 'company_id', 'fit', 'domains', 'phones', 'emails',
  'google_maps_ids', 'profile_quality', 'profiled_at',
]);

discoveryOperator.get('/internal/discovery/jobs/:id/results.csv', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const q = z.object({ country: countryCode.optional() }).safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const [job] = await db()<{ product: string; side: string; identified_name: string | null; created_at: Date }[]>`
    select product, side, identified->>'name' as identified_name, created_at
    from discovery_jobs where id = ${id.data}
  `;
  if (!job) return c.json({ error: 'not found' }, 404);

  const rows = await resultRows(id.data, { ...(q.data.country ? { country: q.data.country } : {}), limit: CSV_MAX_ROWS });
  const values = (r: ResultRow, type: string) =>
    r.identifiers.filter((i) => i.type === type).map((i) => i.value).join('; ');
  const lines = [
    CSV_COLUMNS.join(','),
    ...rows.map((r) =>
      [
        r.rank,
        r.country,
        r.tier,
        r.score.toFixed(3),
        r.company_name,
        r.company_id,
        r.persona_name,
        r.fit,
        values(r, 'domain'),
        values(r, 'phone'),
        values(r, 'email'),
        values(r, 'gmaps'),
        (r.products ?? []).join('; '),
        (r.roles ?? []).join('; '),
        (r.cities ?? []).join('; '),
        r.quality,
        r.profiled_at ? r.profiled_at.toISOString() : '',
        r.evidence.map((e) => `${e.claim}: "${e.quote}" (${e.url})`).join(' | '),
        r.reasons.join(' | '),
      ]
        .map((v, i) => csvCell(v, CSV_VALUE_COLUMNS.has(CSV_COLUMNS[i]!) ? 'value' : 'text'))
        .join(','),
    ),
  ];

  // The product names the file; anything outside plain ASCII goes in filename*.
  const name = (job.identified_name ?? job.product).trim();
  const slug = name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'search';
  const stem = `discovery-${slug}-${job.side}${q.data.country ? `-${q.data.country}` : ''}-${job.created_at.toISOString().slice(0, 10)}`;

  // A byte-order mark so a spreadsheet reads the Arabic as UTF-8.
  return c.body(`\uFEFF${lines.join('\r\n')}\r\n`, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${stem}.csv"; filename*=UTF-8''${encodeURIComponent(`discovery-${name}-${job.side}.csv`)}`,
    'Cache-Control': 'no-store',
  });
});

discoveryOperator.get('/internal/discovery/jobs/:id/candidates', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const q = listQuery
    .extend({
      cursor: z.string().uuid().optional(),
      country: countryCode.optional(),
      // One status or several, comma-separated: `kept,new`.
      status: z
        .string()
        .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
        .pipe(z.array(z.enum(['new', 'kept', 'dropped', 'extracted', 'not_saved', 'failed'])).min(1))
        .optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const sql = db();
  const [job] = await sql`select id from discovery_jobs where id = ${id.data}`;
  if (!job) return c.json({ error: 'not found' }, 404);

  // Saved first, then kept, then the rest; the strongest fits first.
  const order = sql`
    case d.status when 'extracted' then 0 when 'kept' then 1 when 'new' then 2
                  when 'not_saved' then 3 when 'failed' then 4 else 5 end,
    case d.fit when 'strong' then 0 when 'weak' then 1 else 2 end,
    d.created_at, d.id
  `;
  const rows = await sql<Record<string, unknown>[]>`
    select d.id::text as id, k.country, d.kind, d.domain, d.gmaps, d.name, d.url, d.phone,
           d.address, d.category, d.snippets, d.fit, d.status, d.reason,
           d.company_id::text as "companyId", d.evidence,
           coalesce((
             select json_agg(json_build_object('id', p.id, 'name', p.name) order by p.position)
             from discovery_personas p where p.id = any(d.persona_ids)
           ), '[]'::json) as personas
    from discovery_candidates d
    join discovery_tasks k on k.id = d.task_id
    where d.job_id = ${id.data}
      ${q.data.country ? sql`and k.country = ${q.data.country}` : sql``}
      ${q.data.status ? sql`and d.status = any(${q.data.status}::text[])` : sql``}
    order by ${order}
  `;

  // A job's candidates are capped by its queries, so they are read whole and
  // paged in the order above; the cursor is the last row's id.
  const start = q.data.cursor ? rows.findIndex((r) => r['id'] === q.data.cursor) + 1 : 0;
  const items = rows.slice(start, start + q.data.limit);
  return c.json(page(items, q.data.limit));
});

type ResultRow = {
  id: string;
  rank: number;
  score: number;
  reasons: string[];
  country: string;
  tier: 'found' | 'pool';
  fit: 'strong' | 'weak' | null;
  evidence: { claim: string; quote: string; url: string }[];
  persona_id: string | null;
  persona_name: string | null;
  company_id: string;
  company_name: string;
  company_country: string | null;
  has_profile: boolean;
  products: string[] | null;
  roles: string[] | null;
  cities: string[] | null;
  quality: string | null;
  profiled_at: Date | null;
  identifiers: { type: string; value: string }[];
};

/**
 * Why a job or task is not moving, when the engine knows: a deferral to the
 * moment a Claude usage limit resets. Worked out here so no screen has to.
 */
const waiting = (deferredUntil: Date | null) =>
  deferredUntil && deferredUntil.getTime() > Date.now()
    ? { reason: 'usage_limit', until: deferredUntil }
    : null;

/** A job with its plan and tasks, in the shape both create and read return. */
async function oneJob(id: string) {
  const sql = db();
  const [row] = await sql<(Record<string, unknown> & { deferredUntil: Date | null })[]>`
    select j.id::text as id, j.tenant_id::text as "tenantId", t.name as "tenantName",
           j.product, j.category, j.side, j.countries, j.terms,
           j.result_limit as "resultLimit", j.status, j.counts, j.identified, j.error,
           j.product_confirmed as "productConfirmed",
           j.requester_ref as "requesterRef", j.product_ref as "productRef",
           j.rfq_search_id::text as "rfqSearchId", j.line_ref as "lineRef",
           (select rfq_ref from discovery_rfq_searches q where q.id = j.rfq_search_id) as "rfqRef",
           j.source_row as "sourceRow", j.attempts, j.deferrals,
           j.deferred_until as "deferredUntil",
           j.created_at as "createdAt", j.started_at as "startedAt", j.finished_at as "finishedAt"
    from discovery_jobs j
    join tenants t on t.id = j.tenant_id
    where j.id = ${id}
  `;
  if (!row) return undefined;
  const { deferredUntil, ...job } = row;

  const personas = await sql<Record<string, unknown>[]>`
    select id::text as id, position, name, description, roles, sectors,
           search_terms as "searchTerms", places_terms as "placesTerms", signals
    from discovery_personas
    where job_id = ${id}
    order by position
  `;

  const tasks = await sql<(Record<string, unknown> & { deferredUntil: Date | null })[]>`
    select id::text as id, country, status, stage, counts, error, attempts, deferrals,
           deferred_until as "deferredUntil",
           created_at as "createdAt", started_at as "startedAt", finished_at as "finishedAt"
    from discovery_tasks
    where job_id = ${id}
    order by array_position(${job['countries'] as string[]}::text[], country), created_at
  `;

  const spend = await spendOfJob(job['tenantId'] as string, id);

  return {
    job: {
      ...job,
      waiting: waiting(deferredUntil),
      live: job['status'] === 'planning' || job['status'] === 'running',
      spend: spend.job,
    },
    personas,
    tasks: tasks.map(({ deferredUntil: until, ...task }) => ({
      ...task,
      waiting: waiting(until),
      spend: spend.tasks.get(task['id'] as string) ?? spendOf(undefined),
    })),
  };
}
