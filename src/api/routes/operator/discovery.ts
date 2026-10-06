import { Hono } from 'hono';
import { z } from 'zod';
import { db, withTenant } from '../../../db/client.js';
import {
  MAX_COUNTRIES,
  MAX_RESULT_LIMIT,
  createJob,
  readRow,
} from '../../../modules/discovery/index.js';
import { listQuery, page } from './shared.js';

/**
 * Discovery jobs for the operator: create a search for a tenant, and read
 * jobs, their tasks and their ranked results across every tenant. Everything
 * the review screen shows is in these responses; the dashboard works nothing
 * out for itself.
 */
export const discoveryOperator = new Hono();

const country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'an ISO 3166-1 alpha-2 code');

const createBody = z.object({
  tenantId: z.string().uuid(),
  product: z.string().trim().min(2).max(200),
  category: z.string().trim().max(200).optional(),
  countries: z
    .array(country)
    .min(1)
    .max(MAX_COUNTRIES)
    .refine((list) => new Set(list).size === list.length, 'each country once'),
  resultLimit: z.number().int().min(1).max(MAX_RESULT_LIMIT).optional(),
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
      status: z.enum(['running', 'done', 'failed']).optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const sql = db();
  const rows = await sql<Record<string, unknown>[]>`
    select j.id::text as id, j.tenant_id::text as "tenantId", t.name as "tenantName",
           j.product, j.category, j.countries, j.status, j.counts,
           j.created_at as "createdAt", j.finished_at as "finishedAt"
    from discovery_jobs j
    join tenants t on t.id = j.tenant_id
    where true
      ${q.data.tenantId ? sql`and j.tenant_id = ${q.data.tenantId}` : sql``}
      ${q.data.status ? sql`and j.status = ${q.data.status}` : sql``}
      ${q.data.cursor ? sql`and (j.created_at, j.id) < (select created_at, id from discovery_jobs where id = ${q.data.cursor})` : sql``}
    order by j.created_at desc, j.id desc
    limit ${q.data.limit}
  `;
  return c.json(page(rows, q.data.limit));
});

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
    .extend({ cursor: z.string().regex(/^\d+$/).optional(), country: country.optional() })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const sql = db();
  const [job] = await sql`select id from discovery_jobs where id = ${id.data}`;
  if (!job) return c.json({ error: 'not found' }, 404);

  const rows = await sql<ResultRow[]>`
    select r.id::text as id, r.rank, r.score, r.reasons, k.country,
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
    where r.job_id = ${id.data}
      ${q.data.country ? sql`and k.country = ${q.data.country}` : sql``}
      ${q.data.cursor ? sql`and (r.rank, r.id) > (select rank, id from discovery_results where id = ${q.data.cursor})` : sql``}
    order by r.rank, r.id
    limit ${q.data.limit}
  `;

  return c.json(
    page(
      rows.map((r) => ({
        id: r.id,
        rank: r.rank,
        score: r.score,
        reasons: r.reasons,
        country: r.country,
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

type ResultRow = {
  id: string;
  rank: number;
  score: number;
  reasons: string[];
  country: string;
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

/** A job with its tasks, in the shape both create and read return. */
async function oneJob(id: string) {
  const sql = db();
  const [job] = await sql<Record<string, unknown>[]>`
    select j.id::text as id, j.tenant_id::text as "tenantId", t.name as "tenantName",
           j.product, j.category, j.side, j.countries, j.terms,
           j.result_limit as "resultLimit", j.status, j.counts,
           j.created_at as "createdAt", j.finished_at as "finishedAt"
    from discovery_jobs j
    join tenants t on t.id = j.tenant_id
    where j.id = ${id}
  `;
  if (!job) return undefined;

  const tasks = await sql<Record<string, unknown>[]>`
    select id::text as id, country, status, stage, counts, error, attempts,
           created_at as "createdAt", started_at as "startedAt", finished_at as "finishedAt"
    from discovery_tasks
    where job_id = ${id}
    order by array_position(${job['countries'] as string[]}::text[], country), created_at
  `;
  return { job, tasks };
}
