import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import {
  acceptInvite,
  companyForInvite,
  invite,
  openInvite,
  PROFILE_ROLES,
  search,
  setProfile,
  type InviteRow,
} from '../../modules/discovery/index.js';
import { env } from '../../env.js';
import { internalTokenMatches } from './internal.js';
import { CHANNELS } from '../../spine/contacts/normalize.js';
import type { AuthVars } from '../middleware/auth.js';

const searchBody = z.object({
  buys: z.array(z.string().min(1).max(100)).max(50).optional(),
  sector: z.string().min(1).max(100).optional(),
  city: z.string().min(1).max(100).optional(),
  country: z.string().length(2).optional(),
  text: z.string().min(1).max(200).optional(),
  excludeCompanyIds: z.array(z.string().uuid()).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const profileBody = z.object({
  buys: z.array(z.string().min(1).max(100)).max(100).optional(),
  sells: z.array(z.string().min(1).max(100)).max(100).optional(),
  sector: z.string().min(1).max(100).optional(),
  city: z.string().min(1).max(100).optional(),
  size: z.string().min(1).max(50).optional(),
  // The same limits the columns check.
  products: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  roles: z.array(z.enum(PROFILE_ROLES)).max(PROFILE_ROLES.length).optional(),
  cities: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  countries: z
    .array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'an ISO 3166-1 alpha-2 code'))
    .max(50)
    .optional(),
  quality: z.enum(['full', 'thin']).optional(),
  profiledAt: z.coerce.date().optional(),
});

const inviteBody = z.object({
  contact: z
    .object({
      phone: z.string().min(1).optional(),
      email: z.string().min(1).optional(),
      telegram: z.string().min(1).optional(),
    })
    .refine((c) => c.phone ?? c.email ?? c.telegram, {
      message: 'contact needs at least one of phone, email or telegram',
    }),
  channel: z.enum(CHANNELS).optional(),
  template: z.string().min(1).max(200),
  variables: z.record(z.unknown()).optional(),
  defaultCountry: z.string().length(2).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  /** Pass this when the invite came from a search result. */
  finderRunId: z.coerce.number().int().positive().optional(),
});

export const discovery = new Hono<AuthVars>();

discovery.post('/v1/discovery/search', async (c) => {
  const parsed = searchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const result = await withTenant(tenantId, (tx) => search(tx, { tenantId, query: parsed.data }));
  return c.json(result);
});

discovery.put('/v1/companies/:id/profile', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const parsed = profileBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const profile = await withTenant(tenantId, async (tx) => {
    const company = await companyForInvite(tx, id.data);
    if (!company) return null;
    return setProfile(tx, { tenantId, companyId: company.id, ...parsed.data });
  });

  return profile ? c.json({ profile }) : c.json({ error: 'not found' }, 404);
});

discovery.post('/v1/companies/:id/invite', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const parsed = inviteBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const result = await withTenant(tenantId, async (tx) => {
    const company = await companyForInvite(tx, id.data);
    if (!company) return null;
    return invite(tx, { tenantId, companyId: company.id, ...parsed.data });
  });

  if (!result) return c.json({ error: 'not found' }, 404);

  // A refused invite is not an error: the message row says why nothing went.
  return result.invite
    ? c.json({ invite: result.invite, message: result.message }, 202)
    : c.json({ invite: null, message: result.message }, 200);
});

discovery.get('/v1/invites/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const [row] = await withTenant(
    c.get('tenantId'),
    (tx) => tx<InviteRow[]>`select * from invites where id = ${id.data}`,
  );
  return row ? c.json({ invite: row }) : c.json({ error: 'not found' }, 404);
});

/**
 * Routes the marketplace uses, not a tenant. No JWT: one is the invitee
 * following a link, the other is the marketplace's own server.
 */
export const marketplace = new Hono();

marketplace.get('/i/:token', async (c) => {
  const row = await openInvite(c.req.param('token'));
  if (!row) {
    // 410 rather than 404: the link was real, it is just over.
    return c.text('This invitation has expired or has already been used.', 410);
  }

  const url = new URL(env().MARKETPLACE_SIGNUP_URL);
  url.searchParams.set('invite', row.token);
  return c.redirect(url.toString(), 302);
});

marketplace.post('/internal/invites/accept', async (c) => {
  if (!internalTokenMatches(c.req.header('X-Internal-Token') ?? '')) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const parsed = z
    .object({ token: z.string().min(1), ref: z.string().min(1).max(200) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const result = await acceptInvite(parsed.data);
  if (result.ok) return c.json({ companyId: result.companyId, tenantId: result.tenantId });

  return result.reason === 'not_found'
    ? c.json({ error: 'not found' }, 404)
    : c.json({ error: result.reason }, 409);
});

