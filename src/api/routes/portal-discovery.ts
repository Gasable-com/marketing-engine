import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import {
  Identified,
  MAX_COUNTRIES,
  MAX_RESULT_LIMIT,
  MAX_RFQ_LINES,
  assertQuota,
  countryCode,
  createJob,
  createRfqSearch,
  didYouMeanFor,
  identifyProduct,
  listRfqSearches,
  listSearches,
  ownRfqSearch,
  ownSearch,
  portalResults,
  portalSearch,
  quotaFor,
} from '../../modules/discovery/index.js';
import type { AuthVars } from '../middleware/auth.js';

/**
 * Discovery for the marketplace portal: a supplier searching for buyers of
 * one of its products, a corporate searching for suppliers of an RFQ's items.
 * Called by the portal's backend with its tenant token; `requesterRef` is the
 * portal's own id for the user who asked, and every search belongs to it.
 *
 * Responses carry a company's name, city and why it matches, never its
 * contacts: the relationship stays on the marketplace.
 */
export const portalDiscovery = new Hono<AuthVars>();

const ref = z.string().trim().min(1).max(200);
const countries = z
  .array(countryCode)
  .min(1)
  .max(MAX_COUNTRIES)
  .refine((list) => new Set(list).size === list.length, 'each country once')
  .default(['SA']);
const page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});
const notFound = { error: 'not found' } as const;

const searchBody = z.object({
  requesterRef: ref,
  productRef: ref.optional(),
  product: z.string().trim().min(2).max(200),
  category: z.string().trim().max(200).optional(),
  side: z.enum(['suppliers', 'buyers']),
  countries,
  resultLimit: z.number().int().min(1).max(MAX_RESULT_LIMIT).optional(),
  identified: Identified.optional(),
  confirmed: z.boolean().optional(),
});

const rfqBody = z.object({
  requesterRef: ref,
  rfqRef: ref.optional(),
  side: z.enum(['suppliers', 'buyers']).default('suppliers'),
  countries,
  resultLimit: z.number().int().min(1).max(MAX_RESULT_LIMIT).optional(),
  lines: z
    .array(
      z.object({
        lineRef: ref.optional(),
        productRef: ref.optional(),
        product: z.string().trim().min(2).max(200),
        category: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(MAX_RFQ_LINES),
});

const body = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
const invalid = (issues: unknown) => ({ error: 'invalid body', detail: issues });

/** The "did you mean" step, before a search is started. */
portalDiscovery.post('/v1/discovery/identify', async (c) => {
  const parsed = z
    .object({ product: z.string().trim().min(2).max(200), category: z.string().trim().max(200).optional() })
    .safeParse(await body(c));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
  const identified = await identifyProduct(parsed.data);
  return c.json({ identified, didYouMean: didYouMeanFor(parsed.data.product, identified) });
});

portalDiscovery.post('/v1/discovery/searches', async (c) => {
  const parsed = searchBody.safeParse(await body(c));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
  const tenantId = c.get('tenantId');
  const view = await withTenant(tenantId, async (tx) => {
    await assertQuota(tx, tenantId, parsed.data.requesterRef);
    const { job, tasks } = await createJob(tx, { tenantId, ...parsed.data });
    return portalSearch(job, tasks);
  });
  return c.json({ search: view }, 201);
});

portalDiscovery.post('/v1/discovery/rfq-searches', async (c) => {
  const parsed = rfqBody.safeParse(await body(c));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
  const tenantId = c.get('tenantId');
  const view = await withTenant(tenantId, async (tx) => {
    await assertQuota(tx, tenantId, parsed.data.requesterRef);
    const { rfq } = await createRfqSearch(tx, { tenantId, ...parsed.data });
    return ownRfqSearch(tx, rfq.id, parsed.data.requesterRef);
  });
  return c.json({ rfqSearch: view }, 201);
});

portalDiscovery.get('/v1/discovery/searches', async (c) => {
  const q = page
    .extend({ requesterRef: ref, productRef: ref.optional(), status: z.enum(['planning', 'running', 'done', 'failed']).optional() })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);
  const items = await withTenant(c.get('tenantId'), (tx) => listSearches(tx, q.data));
  return c.json({ items, nextCursor: items.length === q.data.limit ? items.at(-1)!.id : null });
});

portalDiscovery.get('/v1/discovery/searches/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const q = z.object({ requesterRef: ref }).safeParse(c.req.query());
  if (!id.success || !q.success) return c.json(notFound, 404);
  const own = await withTenant(c.get('tenantId'), (tx) => ownSearch(tx, id.data, q.data.requesterRef));
  return own ? c.json({ search: own.view }) : c.json(notFound, 404);
});

portalDiscovery.get('/v1/discovery/searches/:id/results', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const q = z.object({ requesterRef: ref }).safeParse(c.req.query());
  if (!id.success || !q.success) return c.json(notFound, 404);
  const answer = await withTenant(c.get('tenantId'), async (tx) => {
    const own = await ownSearch(tx, id.data, q.data.requesterRef);
    return own ? { search: own.view, results: await portalResults(tx, own.job.id) } : null;
  });
  return answer ? c.json(answer) : c.json(notFound, 404);
});

portalDiscovery.get('/v1/discovery/rfq-searches', async (c) => {
  const q = page.extend({ requesterRef: ref, rfqRef: ref.optional() }).safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);
  const items = await withTenant(c.get('tenantId'), (tx) => listRfqSearches(tx, q.data));
  return c.json({ items, nextCursor: items.length === q.data.limit ? items.at(-1)!.id : null });
});

portalDiscovery.get('/v1/discovery/rfq-searches/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const q = z.object({ requesterRef: ref }).safeParse(c.req.query());
  if (!id.success || !q.success) return c.json(notFound, 404);
  const view = await withTenant(c.get('tenantId'), (tx) => ownRfqSearch(tx, id.data, q.data.requesterRef));
  return view ? c.json({ rfqSearch: view }) : c.json(notFound, 404);
});

/** One RFQ search, its results split by product line, in line order. */
portalDiscovery.get('/v1/discovery/rfq-searches/:id/results', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const q = z.object({ requesterRef: ref }).safeParse(c.req.query());
  if (!id.success || !q.success) return c.json(notFound, 404);
  const answer = await withTenant(c.get('tenantId'), async (tx) => {
    const rfq = await ownRfqSearch(tx, id.data, q.data.requesterRef);
    if (!rfq) return null;
    const lines = [];
    for (const line of rfq.lines) {
      lines.push({
        lineRef: line.lineRef,
        position: line.position,
        product: line.product,
        identifiedAs: line.identifiedAs,
        searchId: line.id,
        status: line.status,
        progress: line.progress,
        results: await portalResults(tx, line.id),
      });
    }
    const { lines: _lines, ...rfqSearch } = rfq;
    return { rfqSearch, lines };
  });
  return answer ? c.json(answer) : c.json(notFound, 404);
});

portalDiscovery.get('/v1/discovery/quota', async (c) => {
  const q = z.object({ requesterRef: ref }).safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);
  const tenantId = c.get('tenantId');
  const quota = await withTenant(tenantId, (tx) => quotaFor(tx, tenantId, q.data.requesterRef));
  return c.json(quota);
});
