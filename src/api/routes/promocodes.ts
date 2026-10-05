import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import {
  create,
  reconcile,
  release,
  reserve,
  settle,
  validate,
  type PromocodeRow,
  type RedemptionRow,
} from '../../modules/promocodes/index.js';
import type { AuthVars } from '../middleware/auth.js';

/** Minor units: whole numbers only, never a float. */
const minorUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const cart = z.object({
  currency: z.string().length(3),
  subtotal: minorUnits,
  items: z
    .array(
      z.object({
        sku: z.string().max(200).optional(),
        category: z.string().max(200).optional(),
        qty: z.number().int().min(0),
        unitPrice: minorUnits,
      }),
    )
    .max(500)
    .default([])
    // Line values are summed and split, so their total has to stay a whole
    // number of minor units too.
    .refine(
      (items) =>
        items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0) <= Number.MAX_SAFE_INTEGER,
      { message: 'the items add up to more than a whole number of minor units can hold' },
    ),
});

/** The products a code is limited to, matched against each cart item's `sku`. Empty: all. */
const productIds = z.array(z.string().uuid()).max(500);

const createBody = z.object({
  code: z.string().min(1).max(60),
  currency: z.string().length(3),
  discount: z.object({
    type: z.enum(['percent', 'fixed']),
    /** Basis points for percent: 1000 is 10%. */
    value: minorUnits,
    maxDiscount: minorUnits.optional(),
    minSubtotal: minorUnits.optional(),
    productIds: productIds.optional(),
  }),
  budget: z
    .object({
      maxSpend: minorUnits.optional(),
      maxUses: z.number().int().min(0).optional(),
      perBuyerMaxUses: z.number().int().min(0).optional(),
    })
    .default({}),
  funders: z
    .array(z.object({ party: z.string().min(1).max(100), share: z.number().min(0).max(1) }))
    .min(1)
    .max(20),
  rules: z.record(z.unknown()).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
});

const validateBody = z.object({
  code: z.string().min(1).max(60),
  buyerRef: z.string().min(1).max(200),
  companyId: z.string().uuid().optional(),
  buyerCompanyRef: z.string().min(1).max(200).optional(),
  cart,
  at: z.coerce.date().optional(),
});

export const promocodes = new Hono<AuthVars>();

promocodes.post('/v1/promocodes', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => create(tx, { tenantId, ...parsed.data }));
  return c.json({ promocode: row }, 201);
});

promocodes.get('/v1/promocodes/reconcile', async (c) => {
  const tenantId = c.get('tenantId');
  const result = await withTenant(tenantId, (tx) => reconcile(tx, tenantId));
  return c.json({ reconciliation: result });
});

promocodes.get('/v1/promocodes', async (c) => {
  const status = c.req.query('status');
  const tenantId = c.get('tenantId');

  const rows = await withTenant(tenantId, (tx) =>
    tx<(PromocodeRow & { uses: string; spend: string })[]>`
      select p.*,
             count(r.id) filter (where r.status in ('reserved','settled'))::text as uses,
             coalesce(sum(r.discount_amount) filter (where r.status in ('reserved','settled')), 0)::text as spend
      from promocodes p
      left join redemptions r on r.promocode_id = p.id
      where ${status ? tx`p.status = ${status}` : tx`true`}
      group by p.id
      order by p.created_at desc
    `,
  );

  return c.json({
    promocodes: rows.map(({ uses, spend, ...promo }) => ({
      ...promo,
      usage: { uses: Number(uses), spend: Number(spend) },
    })),
  });
});

promocodes.get('/v1/promocodes/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const [row] = await withTenant(
    c.get('tenantId'),
    (tx) => tx<PromocodeRow[]>`select * from promocodes where id = ${id.data}`,
  );
  return row ? c.json({ promocode: row }) : c.json({ error: 'not found' }, 404);
});

promocodes.patch('/v1/promocodes/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const parsed = z
    .object({
      status: z.enum(['active', 'paused', 'ended']).optional(),
      discount: z.object({ productIds }).optional(),
    })
    .refine((body) => body.status !== undefined || body.discount !== undefined, {
      message: 'nothing to change: send status or discount.productIds',
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);
  const { status, discount } = parsed.data;

  // Only the product list of a discount can change; its type and amounts stay
  // what they were when the code was handed out.
  const [row] = await withTenant(
    c.get('tenantId'),
    (tx) => tx<PromocodeRow[]>`
      update promocodes set
        ${status ? tx`status = ${status},` : tx``}
        ${discount ? tx`discount = discount || ${tx.json(discount)},` : tx``}
        updated_at = now()
      where id = ${id.data} returning *
    `,
  );
  return row ? c.json({ promocode: row }) : c.json({ error: 'not found' }, 404);
});

promocodes.post('/v1/promocodes/validate', async (c) => {
  const parsed = validateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  // An invalid code is a 200 with a reason: checkout asks this while the buyer
  // is still typing, and "no" is an answer, not an error.
  const result = await withTenant(tenantId, (tx) => validate(tx, { tenantId, ...parsed.data }));
  return c.json(result);
});

promocodes.post('/v1/redemptions', async (c) => {
  const parsed = validateBody
    .extend({
      orderRef: z.string().min(1).max(200),
      ttlMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const result = await withTenant(tenantId, (tx) => reserve(tx, { tenantId, ...parsed.data }));

  return result.reserved
    ? c.json({ redemption: result.redemption, lines: result.lines }, 201)
    : c.json({ valid: false, reason: result.reason, ...(result.rule ? { rule: result.rule } : {}) });
});

promocodes.post('/v1/redemptions/:id/settle', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const parsed = z
    .object({ finalDiscountAmount: minorUnits.optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) =>
    settle(tx, { tenantId, redemptionId: id.data, ...parsed.data }),
  );
  return c.json({ redemption: row });
});

promocodes.post('/v1/redemptions/:id/release', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const parsed = z
    .object({ reason: z.string().min(1).max(200) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) =>
    release(tx, { tenantId, redemptionId: id.data, reason: parsed.data.reason }),
  );
  return c.json({ redemption: row });
});

promocodes.get('/v1/redemptions', async (c) => {
  const orderRef = c.req.query('orderRef');
  if (!orderRef) return c.json({ error: 'orderRef query parameter is required' }, 400);

  const [row] = await withTenant(
    c.get('tenantId'),
    (tx) => tx<RedemptionRow[]>`select * from redemptions where order_ref = ${orderRef}`,
  );
  return row ? c.json({ redemption: row }) : c.json({ error: 'not found' }, 404);
});

promocodes.get('/v1/redemptions/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const [row] = await withTenant(
    c.get('tenantId'),
    (tx) => tx<RedemptionRow[]>`select * from redemptions where id = ${id.data}`,
  );
  return row ? c.json({ redemption: row }) : c.json({ error: 'not found' }, 404);
});
