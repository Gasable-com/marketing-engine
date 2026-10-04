import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import {
  addMembers,
  addMembersByAddress,
  cancelCampaign,
  createAudience,
  createCampaign,
  deleteAudience,
  duplicateCampaign,
  getAudience,
  getCampaign,
  getContact,
  importContacts,
  latestRuns,
  listAudiences,
  listCampaigns,
  listContacts,
  listRecipients,
  listRuns,
  memberCount,
  patchAudience,
  patchCampaign,
  patchContact,
  pauseCampaign,
  previewAudience,
  removeMember,
  resumeCampaign,
  scheduleCampaign,
  unscheduleCampaign,
  upsertContact,
  type AudienceRow,
  type CampaignRow,
  type ContactRow,
  type RunCounts,
} from '../../modules/campaigns/index.js';
import { CHANNELS, PURPOSES } from '../../spine/contacts/normalize.js';
import { parseCsv } from '../../spine/registry/csv.js';
import type { AuthVars } from '../middleware/auth.js';

const uuid = z.string().uuid();
const channel = z.enum(CHANNELS);

const contactFields = z.object({
  phone: z.string().min(1).max(50).optional(),
  email: z.string().min(1).max(320).optional(),
  telegram: z.string().min(1).max(100).optional(),
  companyId: uuid.optional(),
  name: z.string().min(1).max(500).optional(),
  locale: z.string().min(2).max(35).optional(),
  attributes: z.record(z.unknown()).optional(),
  defaultCountry: z.string().length(2).optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(100).optional(),
});

const finderQuery = z.object({
  buys: z.array(z.string().min(1).max(100)).max(50).optional(),
  sector: z.string().min(1).max(100).optional(),
  city: z.string().min(1).max(100).optional(),
  country: z.string().length(2).optional(),
  text: z.string().min(1).max(200).optional(),
  excludeCompanyIds: z.array(uuid).max(200).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
});

const searchDefinition = z.object({
  finderQuery,
  contactFilter: z
    .object({
      hasChannel: z.array(channel).max(4).optional(),
      tags: z.array(z.string().min(1).max(60)).max(50).optional(),
      companyIds: z.array(uuid).max(1000).optional(),
    })
    .optional(),
});

const audienceBody = z.discriminatedUnion('kind', [
  z.object({ name: z.string().min(1).max(200), kind: z.literal('static') }),
  z.object({ name: z.string().min(1).max(200), kind: z.literal('search'), definition: searchDefinition }),
]);

const recurrence = z.object({
  cron: z.string().min(9).max(100),
  endsAt: z.string().datetime({ offset: true }).optional(),
  maxRuns: z.number().int().min(1).max(10_000).optional(),
});

const campaignBody = z.object({
  name: z.string().min(1).max(200),
  audienceId: uuid,
  template: z.string().min(1).max(200),
  channel: channel.nullable().optional(),
  purpose: z.enum(PURPOSES),
  variables: z.record(z.unknown()).optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
  recurrence: recurrence.nullable().optional(),
  timezone: z.string().min(1).max(100).optional(),
  throttlePerMinute: z.number().int().min(1).max(600).optional(),
});

const campaignStatus = z.enum(['draft', 'scheduled', 'running', 'paused', 'done', 'cancelled', 'failed']);

export const campaigns = new Hono<AuthVars>();

const invalid = (issues: z.ZodIssue[]) => ({ error: 'invalid body', detail: issues });

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

campaigns.post('/v1/contacts', async (c) => {
  const parsed = contactFields.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);

  const tenantId = c.get('tenantId');
  const result = await withTenant(tenantId, (tx) => upsertContact(tx, { tenantId, ...parsed.data }));
  return c.json({ contact: serialiseContact(result.contact), created: result.created }, result.created ? 201 : 200);
});

/**
 * Import contacts, with consent where a row carries its evidence. Synchronous,
 * in batches of 500 that each commit on their own.
 */
campaigns.post('/v1/contacts/import', async (c) => {
  const defaultCountry = z.string().length(2).optional().safeParse(c.req.query('defaultCountry'));
  if (!defaultCountry.success) return c.json({ error: 'defaultCountry must be two letters' }, 400);

  const tenantId = c.get('tenantId');
  const summary = await importContacts({
    tenantId,
    csv: await c.req.text(),
    ...(defaultCountry.data ? { defaultCountry: defaultCountry.data.toUpperCase() } : {}),
  });
  return c.json(summary);
});

campaigns.get('/v1/contacts', async (c) => {
  const q = listQuery
    .extend({ q: z.string().min(1).max(200).optional(), companyId: uuid.optional() })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const rows = await withTenant(c.get('tenantId'), (tx) => listContacts(tx, q.data));
  return c.json(page(rows.map(serialiseContact), q.data.limit));
});

campaigns.get('/v1/contacts/:id', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const row = await withTenant(c.get('tenantId'), (tx) => getContact(tx, id.data));
  return row ? c.json({ contact: serialiseContact(row) }) : c.json({ error: 'not found' }, 404);
});

campaigns.patch('/v1/contacts/:id', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const parsed = contactFields.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => patchContact(tx, { tenantId, id: id.data, ...parsed.data }));
  return row ? c.json({ contact: serialiseContact(row) }) : c.json({ error: 'not found' }, 404);
});

// ---------------------------------------------------------------------------
// Audiences
// ---------------------------------------------------------------------------

campaigns.post('/v1/audiences', async (c) => {
  const parsed = audienceBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => createAudience(tx, { tenantId, ...parsed.data }));
  return c.json({ audience: serialiseAudience(row, row.kind === 'static' ? 0 : null) }, 201);
});

campaigns.get('/v1/audiences', async (c) => {
  const rows = await withTenant(c.get('tenantId'), (tx) => listAudiences(tx));
  return c.json({ items: rows.map((r) => serialiseAudience(r, r.members)) });
});

campaigns.get('/v1/audiences/:id', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const found = await withTenant(c.get('tenantId'), async (tx) => {
    const row = await getAudience(tx, id.data);
    if (!row) return null;
    return { row, members: row.kind === 'static' ? await memberCount(tx, row.id) : null };
  });
  return found
    ? c.json({ audience: serialiseAudience(found.row, found.members) })
    : c.json({ error: 'not found' }, 404);
});

campaigns.patch('/v1/audiences/:id', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const parsed = z
    .object({ name: z.string().min(1).max(200).optional(), definition: searchDefinition.optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => patchAudience(tx, { tenantId, id: id.data, ...parsed.data }));
  return row ? c.json({ audience: serialiseAudience(row, null) }) : c.json({ error: 'not found' }, 404);
});

campaigns.delete('/v1/audiences/:id', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const tenantId = c.get('tenantId');
  const deleted = await withTenant(tenantId, (tx) => deleteAudience(tx, { tenantId, id: id.data }));
  return deleted ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
});

/**
 * Add members to a static audience: `{ contactIds }` as JSON, or a CSV of
 * addresses with any of the columns phone, email, telegram, name. Addresses
 * nobody has stored yet become contacts, with no consent.
 */
campaigns.post('/v1/audiences/:id/members', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const tenantId = c.get('tenantId');

  if ((c.req.header('Content-Type') ?? '').startsWith('text/csv')) {
    const rows = parseCsv(await c.req.text());
    const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const allowed = ['phone', 'email', 'telegram', 'name'];
    if (!header.length || header.some((h) => !allowed.includes(h))) {
      return c.json({ error: `CSV columns must be among: ${allowed.join(', ')}` }, 400);
    }
    if (rows.length > 20_000) return c.json({ error: 'at most 20000 rows' }, 400);

    const defaultCountry = c.req.query('defaultCountry');
    const fields = rows.map((row) => {
      const out: Record<string, string> = {};
      header.forEach((key, i) => {
        const value = (row[i] ?? '').trim();
        if (value) out[key] = value;
      });
      return { ...out, ...(defaultCountry ? { defaultCountry: defaultCountry.toUpperCase() } : {}) };
    });

    const result = await withTenant(tenantId, (tx) =>
      addMembersByAddress(tx, { tenantId, audienceId: id.data, rows: fields }),
    );
    return c.json(result);
  }

  const parsed = z
    .object({ contactIds: z.array(uuid).min(1).max(10_000) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);

  const result = await withTenant(tenantId, (tx) =>
    addMembers(tx, { audienceId: id.data, contactIds: parsed.data.contactIds }),
  );
  return c.json(result);
});

campaigns.delete('/v1/audiences/:id/members/:contactId', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  const contactId = uuid.safeParse(c.req.param('contactId'));
  if (!id.success || !contactId.success) return c.json({ error: 'not found' }, 404);

  const removed = await withTenant(c.get('tenantId'), (tx) =>
    removeMember(tx, { audienceId: id.data, contactId: contactId.data }),
  );
  return removed ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
});

/**
 * Who would actually get a send to this audience: the first `limit` contacts,
 * each with send()'s verdict for `purpose` (and `channel`, if named), plus the
 * audience's total size. `evaluateAt` judges the sending window at another
 * time, e.g. when the campaign is scheduled for.
 */
campaigns.post('/v1/audiences/:id/preview', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const q = z
    .object({
      limit: z.coerce.number().int().min(1).max(200).default(20),
      purpose: z.enum(PURPOSES).default('marketing'),
      channel: channel.optional(),
      evaluateAt: z.coerce.date().optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const preview = await withTenant(tenantId, (tx) =>
    previewAudience(tx, {
      tenantId,
      audienceId: id.data,
      limit: q.data.limit,
      purpose: q.data.purpose,
      ...(q.data.channel ? { channel: q.data.channel } : {}),
      ...(q.data.evaluateAt ? { at: q.data.evaluateAt } : {}),
    }),
  );
  return c.json(preview);
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

campaigns.post('/v1/campaigns', async (c) => {
  const parsed = campaignBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => createCampaign(tx, { tenantId, ...parsed.data }));
  return c.json({ campaign: serialiseCampaign(row, null) }, 201);
});

campaigns.get('/v1/campaigns', async (c) => {
  const status = campaignStatus.optional().safeParse(c.req.query('status'));
  if (!status.success) return c.json({ error: 'invalid status' }, 400);

  const rows = await withTenant(c.get('tenantId'), (tx) => listCampaigns(tx, { status: status.data }));
  return c.json({ items: rows.map((r) => serialiseCampaign(r.campaign, r.lastRun)) });
});

campaigns.get('/v1/campaigns/:id', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const found = await withTenant(c.get('tenantId'), async (tx) => {
    const row = await getCampaign(tx, id.data);
    if (!row) return null;
    return { row, last: (await latestRuns(tx, [row.id])).get(row.id) ?? null };
  });
  return found
    ? c.json({ campaign: serialiseCampaign(found.row, found.last) })
    : c.json({ error: 'not found' }, 404);
});

campaigns.patch('/v1/campaigns/:id', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const parsed = campaignBody.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => patchCampaign(tx, { tenantId, id: id.data, ...parsed.data }));
  return row ? c.json({ campaign: serialiseCampaign(row, null) }) : c.json({ error: 'not found' }, 404);
});

const actions = {
  schedule: scheduleCampaign,
  unschedule: unscheduleCampaign,
  pause: pauseCampaign,
  resume: resumeCampaign,
  cancel: cancelCampaign,
} as const;

for (const [action, fn] of Object.entries(actions)) {
  campaigns.post(`/v1/campaigns/:id/${action}`, async (c) => {
    const id = uuid.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'not found' }, 404);

    const tenantId = c.get('tenantId');
    const row = await withTenant(tenantId, (tx) => fn(tx, { tenantId, id: id.data }));
    return row ? c.json({ campaign: serialiseCampaign(row, null) }) : c.json({ error: 'not found' }, 404);
  });
}

/** A new draft copied from any campaign. `name` defaults to "<name> (copy)". */
campaigns.post('/v1/campaigns/:id/duplicate', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);
  const parsed = z
    .object({ name: z.string().min(1).max(200).optional() })
    .safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) =>
    duplicateCampaign(tx, { tenantId, id: id.data, name: parsed.data.name }),
  );
  return row ? c.json({ campaign: serialiseCampaign(row, null) }, 201) : c.json({ error: 'not found' }, 404);
});

campaigns.get('/v1/campaigns/:id/runs', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const found = await withTenant(c.get('tenantId'), async (tx) => {
    const row = await getCampaign(tx, id.data);
    return row ? listRuns(tx, row.id) : null;
  });
  return found ? c.json({ items: found.map(serialiseRun) }) : c.json({ error: 'not found' }, 404);
});

campaigns.get('/v1/campaigns/:id/runs/:runId/recipients', async (c) => {
  const id = uuid.safeParse(c.req.param('id'));
  const runId = uuid.safeParse(c.req.param('runId'));
  if (!id.success || !runId.success) return c.json({ error: 'not found' }, 404);
  const q = listQuery
    .extend({ state: z.enum(['pending', 'queued', 'blocked', 'skipped']).optional() })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const found = await withTenant(c.get('tenantId'), async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      select id from campaign_runs where id = ${runId.data} and campaign_id = ${id.data}
    `;
    return run ? listRecipients(tx, { runId: run.id, ...q.data }) : null;
  });
  if (!found) return c.json({ error: 'not found' }, 404);

  const last = found[found.length - 1];
  return c.json({
    items: found,
    nextCursor: found.length === q.data.limit && last ? last.contactId : null,
  });
});

// ---------------------------------------------------------------------------

function page<T extends { id: string }>(items: T[], limit: number) {
  const last = items[items.length - 1];
  return { items, nextCursor: items.length === limit && last ? last.id : null };
}

function serialiseContact(row: ContactRow) {
  return {
    id: row.id,
    phone: row.phone,
    email: row.email,
    telegram: row.telegram,
    companyId: row.company_id,
    name: row.name,
    locale: row.locale,
    attributes: row.attributes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function serialiseAudience(row: AudienceRow, members: number | null) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    definition: row.kind === 'search' ? row.definition : null,
    members,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function serialiseRun(row: RunCounts) {
  return {
    id: row.id,
    runNo: row.run_no,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    audienceSize: row.audience_size,
    queued: row.queued,
    blocked: row.blocked,
    skipped: row.skipped,
    pending: row.pending,
    deferred: row.deferred,
    error: row.error,
  };
}

function serialiseCampaign(row: CampaignRow, lastRun: RunCounts | null) {
  return {
    id: row.id,
    name: row.name,
    audienceId: row.audience_id,
    template: row.template,
    channel: row.channel,
    purpose: row.purpose,
    variables: row.variables,
    scheduledAt: row.scheduled_at?.toISOString() ?? null,
    recurrence: row.recurrence,
    timezone: row.timezone,
    throttlePerMinute: row.throttle_per_minute,
    status: row.status,
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    lastRun: lastRun ? serialiseRun(lastRun) : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
