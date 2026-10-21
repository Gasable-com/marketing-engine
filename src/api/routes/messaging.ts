import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import { hiddenContactByAddress } from '../../modules/campaigns/index.js';
import {
  getChannelConfig,
  redactConfig,
  send,
  storeChannelConfig,
  type ContactInput,
  upsertTemplate,
  validateChannelConfig,
  type MessageRow,
} from '../../modules/messaging/index.js';
import { CHANNELS, PURPOSES } from '../../spine/contacts/normalize.js';
import { resolve as resolveCompany } from '../../spine/registry/index.js';
import type { AuthVars } from '../middleware/auth.js';

const channel = z.enum(CHANNELS);

const channelConfigBody = z.object({
  provider: z.string().min(1).max(50),
  sender: z.string().min(1).max(50),
  unsubscribeText: z.string().min(1).max(200).optional(),
  config: z.record(z.unknown()),
});

const templateBody = z.object({
  channel,
  body: z.string().min(1).max(5000),
  subject: z.string().min(1).max(500).optional(),
  providerRef: z.record(z.unknown()).optional(),
});

const contactShape = z
  .object({
    phone: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    telegram: z.string().min(1).optional(),
  })
  .refine((c) => c.phone ?? c.email ?? c.telegram, {
    message: 'contact needs at least one of phone, email or telegram',
  });

const sendBody = z
  .object({
    contact: contactShape.optional(),
    channel: channel.optional(),
    // The step 3 shape. Accepted for one release, then removed.
    address: z.string().min(1).optional(),
    purpose: z.enum(PURPOSES),
    template: z.string().min(1).max(200),
    variables: z.record(z.unknown()).optional(),
    defaultCountry: z.string().length(2).optional(),
    /** The clock the sending window and rules are evaluated at. Not a schedule. */
    evaluateAt: z.coerce.date().optional(),
    // The old name for evaluateAt. Accepted for one release, then removed.
    at: z.coerce.date().optional(),
  })
  .refine((b) => b.contact ?? (b.channel && b.address), {
    message: 'send needs a contact, or the older channel and address pair',
  });

/** Fold the old { channel, address } shape into a contact. */
function contactOf(body: z.infer<typeof sendBody>): ContactInput {
  if (body.contact) return body.contact;
  const address = body.address!;
  switch (body.channel!) {
    case 'sms':
    case 'whatsapp':
      return { phone: address };
    case 'email':
      return { email: address };
    case 'telegram':
      return { telegram: address };
  }
}

export const messaging = new Hono<AuthVars>();

messaging.put('/v1/channels/:channel', async (c) => {
  const ch = channel.safeParse(c.req.param('channel'));
  if (!ch.success) return c.json({ error: 'unknown channel' }, 404);

  const parsed = channelConfigBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');

  // Validate first: this talks to the provider over HTTP, and holding a
  // transaction open across that round trip pins a connection for its latency.
  await validateChannelConfig({ channel: ch.data, ...parsed.data });

  const row = await withTenant(tenantId, (tx) =>
    storeChannelConfig(tx, { tenantId, channel: ch.data, ...parsed.data }),
  );
  return c.json({ channel: redactConfig(row) });
});

messaging.get('/v1/channels/:channel', async (c) => {
  const ch = channel.safeParse(c.req.param('channel'));
  if (!ch.success) return c.json({ error: 'unknown channel' }, 404);

  const tenantId = c.get('tenantId');
  const row = await withTenant(tenantId, (tx) => getChannelConfig(tx, tenantId, ch.data));
  return row ? c.json({ channel: redactConfig(row) }) : c.json({ error: 'not found' }, 404);
});

messaging.put('/v1/templates/:name', async (c) => {
  const parsed = templateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const name = c.req.param('name');
  const row = await withTenant(tenantId, (tx) =>
    upsertTemplate(tx, { tenantId, name, ...parsed.data }),
  );
  return c.json({ template: { name: row.name, channel: row.channel, body: row.body } });
});

/**
 * Send one intent now. `evaluateAt` only moves the clock the sending window and
 * rules are checked against; it is not a schedule.
 *
 * This does not delay the send; use campaigns for that.
 */
messaging.post('/v1/messages', async (c) => {
  const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);
  // Outreach is what a campaign sends to the buyers a discovery audience
  // resolved to, whose addresses the engine picks. A single send names an
  // address, so it is marketing or transactional.
  if (parsed.data.purpose === 'outreach') {
    return c.json(
      { error: 'purpose_not_allowed', message: 'outreach is sent by a campaign to a discovery audience only' },
      400,
    );
  }

  const tenantId = c.get('tenantId');
  const { address: _legacy, contact: _contact, evaluateAt, at, ...rest } = parsed.data;
  const clock = evaluateAt ?? at;
  const row = await withTenant(tenantId, (tx) =>
    send(tx, {
      tenantId,
      ...rest,
      contact: contactOf(parsed.data),
      ...(clock ? { at: clock } : {}),
    }),
  );

  // 202 when it is on the queue, 200 when can_send refused and nothing will go.
  return c.json({ message: serialise(row) }, row.status === 'queued' ? 202 : 200);
});

/**
 * A message to a hidden contact (an outreach contact the engine made for a
 * found buyer) shows its company and no address: it never says which of the
 * buyer's addresses the engine used. Every other message shows its address,
 * as before.
 */
messaging.get('/v1/messages/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const found = await withTenant(tenantId, async (tx) => {
    const [row] = await tx<MessageRow[]>`select * from messages where id = ${id.data}`;
    if (!row) return null;
    const hidden = row.address ? await hiddenContactByAddress(tx, tenantId, row.address) : undefined;
    const company = row.company_id ? await resolveCompany(tx, row.company_id) : undefined;
    return {
      row,
      hidden: hidden !== undefined,
      company: company ? { id: company.id, name: company.name } : null,
    };
  });
  return found
    ? c.json({ message: serialise(found.row, found) })
    : c.json({ error: 'not found' }, 404);
});

function serialise(
  row: MessageRow,
  view: { hidden: boolean; company: { id: string; name: string } | null } = { hidden: false, company: null },
) {
  return {
    id: row.id,
    channel: row.channel,
    address: view.hidden ? null : row.address,
    company: view.company,
    region: row.region,
    purpose: row.purpose,
    template: row.template_name,
    body: row.body,
    status: row.status,
    fallbackChannels: row.fallback_channels,
    parentMessageId: row.parent_message_id,
    campaignRunId: row.campaign_run_id,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    blockedReason: row.blocked_reason,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
