import type { Tx } from '../../db/client.js';
import { isPromotional, normalize, type Channel, type Purpose } from '../../spine/contacts/normalize.js';
import { emit } from '../../spine/events/index.js';
import { decrypt, encrypt } from '../../spine/secrets.js';
import { enqueue } from '../../jobs/index.js';
import { adapterFor, type ProviderConfig } from './adapters/index.js';
import { MessagingError } from './errors.js';
import { findByIdentifier } from '../../spine/registry/index.js';
import { addressFor, selectChannel, type ContactInput, type WindowBlock } from './selection.js';
import { assertParses, render } from './templates.js';

export type { ContactInput } from './selection.js';
export { addressFor } from './selection.js';
export type { WindowBlock } from './selection.js';

export const SEND_JOB = 'message.send';

/** Three provider attempts before a message is failed and falls back. */
export const SEND_RETRY_LIMIT = 3;

export type ChannelConfigRow = {
  id: string;
  tenant_id: string;
  channel: string;
  provider: string;
  sender: string;
  unsubscribe_text: string | null;
  config_ciphertext: Buffer;
  config_iv: Buffer;
  config_tag: Buffer;
  created_at: Date;
  updated_at: Date;
};

export type MessageRow = {
  id: string;
  tenant_id: string;
  channel: string;
  address: string;
  region: string | null;
  purpose: string;
  template_name: string;
  body: string;
  provider: string | null;
  provider_message_id: string | null;
  status: 'blocked' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  blocked_reason: string | null;
  error: string | null;
  contact: ContactInput;
  variables: Record<string, unknown>;
  fallback_channels: string[];
  parent_message_id: string | null;
  company_id: string | null;
  campaign_run_id: string | null;
  created_at: Date;
  updated_at: Date;
};

/** What a channel config looks like from outside. Never the credentials. */
export function redactConfig(row: ChannelConfigRow) {
  return {
    channel: row.channel,
    provider: row.provider,
    sender: row.sender,
    unsubscribeText: row.unsubscribe_text,
    configured: true,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Ask the provider whether these credentials work. Deliberately separate from
 * storing them: this makes an HTTP call, and no database transaction should be
 * held open across a round trip to someone else's API.
 */
export async function validateChannelConfig(input: {
  channel: Channel;
  provider: string;
  sender: string;
  config: ProviderConfig;
}): Promise<void> {
  const adapter = adapterFor(input.provider, input.channel);
  if (!adapter) {
    throw new MessagingError('unknown_provider', 422, `no adapter for provider ${input.provider}`);
  }
  const check = await adapter.validateCredentials(input.config, input.sender);
  if (!check.ok) throw new MessagingError('credentials_rejected', 422, check.reason);
}

/** Store credentials that validateChannelConfig has already accepted. */
export async function storeChannelConfig(
  tx: Tx,
  input: {
    tenantId: string;
    channel: Channel;
    provider: string;
    sender: string;
    unsubscribeText?: string | undefined;
    config: ProviderConfig;
  },
): Promise<ChannelConfigRow> {
  const sealed = encrypt(input.config);

  const [row] = await tx<ChannelConfigRow[]>`
    insert into tenant_channel_configs
      (tenant_id, channel, provider, sender, unsubscribe_text,
       config_ciphertext, config_iv, config_tag)
    values (${input.tenantId}, ${input.channel}, ${input.provider}, ${input.sender},
            ${input.unsubscribeText ?? null},
            ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag})
    on conflict (tenant_id, channel) do update set
      provider          = excluded.provider,
      sender            = excluded.sender,
      unsubscribe_text  = excluded.unsubscribe_text,
      config_ciphertext = excluded.config_ciphertext,
      config_iv         = excluded.config_iv,
      config_tag        = excluded.config_tag,
      updated_at        = now()
    returning *
  `;
  if (!row) throw new Error('storeChannelConfig wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'channel.configured',
    subjectType: 'channel',
    subjectId: input.channel,
    payload: { provider: input.provider, sender: input.sender },
  });

  return row;
}

export async function getChannelConfig(
  tx: Tx,
  tenantId: string,
  channel: string,
): Promise<ChannelConfigRow | undefined> {
  const [row] = await tx<ChannelConfigRow[]>`
    select * from tenant_channel_configs
    where tenant_id = ${tenantId} and channel = ${channel}
  `;
  return row;
}

export async function listChannelConfigs(
  tx: Tx,
  tenantId: string,
): Promise<Map<Channel, ChannelConfigRow>> {
  const rows = await tx<ChannelConfigRow[]>`
    select * from tenant_channel_configs where tenant_id = ${tenantId}
  `;
  return new Map(rows.map((r) => [r.channel as Channel, r]));
}

export type TemplateRow = {
  id: string;
  tenant_id: string;
  name: string;
  channel: string;
  body: string;
  subject: string | null;
  provider_ref: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

export async function upsertTemplate(
  tx: Tx,
  input: {
    tenantId: string;
    name: string;
    channel: Channel;
    body: string;
    subject?: string | undefined;
    providerRef?: Record<string, unknown> | undefined;
  },
): Promise<TemplateRow> {
  assertParses(input.body);

  if (input.subject) assertParses(input.subject);

  const [row] = await tx<TemplateRow[]>`
    insert into templates (tenant_id, name, channel, body, subject, provider_ref)
    values (${input.tenantId}, ${input.name}, ${input.channel}, ${input.body},
            ${input.subject ?? null},
            ${input.providerRef ? tx.json(input.providerRef as never) : null})
    on conflict (tenant_id, name, channel) do update set
      body         = excluded.body,
      subject      = excluded.subject,
      provider_ref = excluded.provider_ref,
      updated_at   = now()
    returning *
  `;
  if (!row) throw new Error('upsertTemplate wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'template.saved',
    subjectType: 'template',
    subjectId: input.name,
    payload: { channel: input.channel },
  });

  return row;
}

/**
 * The send intent. Picks a channel, runs can_send, renders, queues. Never talks
 * to a provider: that is the worker's job, after this has committed.
 *
 * Every query scopes by tenant explicitly rather than leaning on RLS, because
 * this also runs from the send worker's fallback path.
 */
export async function send(
  tx: Tx,
  input: {
    tenantId: string;
    contact: ContactInput;
    /** Omit to let the rules pick. */
    channel?: Channel | undefined;
    purpose: Purpose;
    template: string;
    variables?: Record<string, unknown> | undefined;
    defaultCountry?: string | undefined;
    at?: Date | undefined;
    parentMessageId?: string | undefined;
    /** Set by the fallback path; otherwise selection works it out. */
    fallbackChannels?: Channel[] | undefined;
    /** Set when a campaign sent this, so the run can be traced from the message. */
    campaignRunId?: string | undefined;
  },
): Promise<SendResult> {
  const configs = await listChannelConfigs(tx, input.tenantId);

  if (input.channel) {
    if (!addressFor(input.contact, input.channel)) {
      throw new MessagingError(
        'address_missing',
        400,
        `the contact has no address for channel ${input.channel}`,
      );
    }
    if (!configs.has(input.channel)) {
      throw new MessagingError(
        'channel_not_configured',
        409,
        `no provider configured for channel ${input.channel}`,
      );
    }
  }

  const selection = await selectChannel(tx, {
    tenantId: input.tenantId,
    contact: input.contact,
    purpose: input.purpose,
    configuredChannels: new Set(configs.keys()),
    ...(input.channel ? { preferred: input.channel } : {}),
    ...(input.at ? { at: input.at } : {}),
    ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
  });

  if (!selection.chosen) {
    const row = await insertMessage(tx, {
      ...input,
      channel: input.channel ?? 'sms',
      address: input.channel ? (addressFor(input.contact, input.channel) ?? '') : '',
      region: null,
      body: '',
      status: 'blocked',
      blockedReason: 'no_channel',
      fallbackChannels: [],
    });
    await emit(tx, {
      tenantId: input.tenantId,
      type: 'message.blocked',
      subjectType: 'message',
      subjectId: row.id,
      payload: { reason: 'no_channel', purpose: input.purpose, channels: selection.reasons },
    });
    return { ...row, reason: blockedReason(selection.reasons) };
  }

  const { channel, address } = selection.chosen;
  const config = configs.get(channel)!;
  const contact = normalize({
    channel,
    address,
    ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
  });

  const [template] = await tx<TemplateRow[]>`
    select * from templates
    where tenant_id = ${input.tenantId} and name = ${input.template} and channel = ${channel}
  `;
  if (!template) {
    throw new MessagingError(
      'template_not_found',
      404,
      `no template named ${input.template} for channel ${channel}`,
    );
  }

  const fallback = input.fallbackChannels ?? selection.fallback;
  const rendered = await renderFor(channel, template, withContact(input.variables, contact.address));

  let body = rendered.body;
  if (isPromotional(input.purpose) && channel !== 'email') {
    // Email carries its opt-out in the List-Unsubscribe header instead.
    const unsubscribe = config.unsubscribe_text?.trim();
    if (!unsubscribe) {
      throw new MessagingError(
        'unsubscribe_text_required',
        422,
        `channel ${channel} has no unsubscribe_text, which ${input.purpose} messages require`,
      );
    }
    body = `${body}\n${unsubscribe}`;
  }

  // Which company this went to, if the address is one we know. One indexed
  // lookup on a unique key; a miss is normal and costs nothing.
  const company = await companyForAddress(tx, channel, contact.address);

  const row = await insertMessage(tx, {
    ...input,
    channel,
    address: contact.address,
    region: contact.region,
    body,
    status: 'queued',
    fallbackChannels: fallback,
    ...(company ? { companyId: company } : {}),
  });

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'message.queued',
    subjectType: 'message',
    subjectId: row.id,
    payload: {
      channel,
      purpose: input.purpose,
      provider: config.provider,
      fallbackChannels: fallback,
    },
  });

  await enqueue(tx, SEND_JOB, { messageId: row.id }, {
    retryLimit: SEND_RETRY_LIMIT,
    retryBackoff: true,
  });

  return { ...row, reason: null };
}

/**
 * What send() hands back: the row, plus the one reason worth recording when it
 * was blocked. The row's own blocked_reason says `no_channel` for nearly every
 * block; this says why, e.g. `no_consent`.
 */
export type SendResult = MessageRow & { reason: string | null };

/**
 * The reason a blocked send is blocked, from selection's reason per channel.
 * Channels the contact has no address for, or the tenant no provider for, were
 * never candidates and say nothing. What is left is one reason when every
 * candidate agrees, and `channel:reason` pairs when they do not.
 */
export function blockedReason(reasons: Record<string, string>): string {
  const candidates = Object.entries(reasons).filter(
    ([, reason]) => reason !== 'no_address' && reason !== 'channel_not_configured',
  );
  if (candidates.length === 0) return 'no_channel';
  const distinct = [...new Set(candidates.map(([, reason]) => reason))];
  if (distinct.length === 1) return distinct[0]!;
  return candidates.map(([channel, reason]) => `${channel}:${reason}`).join(';');
}

/**
 * The variables a template sees. `contact.address` is always the address the
 * message goes to; anything else the caller put under `contact` stays.
 */
export function withContact(
  variables: Record<string, unknown> | undefined,
  address: string,
): Record<string, unknown> {
  const given = variables?.['contact'];
  const extra = given && typeof given === 'object' ? (given as Record<string, unknown>) : {};
  return { ...(variables ?? {}), contact: { ...extra, address } };
}

/**
 * Would send() let this intent out, and on which channel? The same selection
 * send() runs, with nothing written. For previews: "who will actually get this".
 */
export async function preflight(
  tx: Tx,
  input: {
    tenantId: string;
    contact: ContactInput;
    purpose: Purpose;
    channel?: Channel | undefined;
    at?: Date | undefined;
  },
): Promise<PreflightResult> {
  const configured = new Set((await listChannelConfigs(tx, input.tenantId)).keys());

  if (input.channel) {
    if (!addressFor(input.contact, input.channel)) return { allowed: false, reason: 'address_missing' };
    if (!configured.has(input.channel)) return { allowed: false, reason: 'channel_not_configured' };
  }

  const selection = await selectChannel(tx, {
    tenantId: input.tenantId,
    contact: input.contact,
    purpose: input.purpose,
    configuredChannels: configured,
    ...(input.channel ? { preferred: input.channel } : {}),
    ...(input.at ? { at: input.at } : {}),
  });

  if (selection.chosen) return { allowed: true, channel: selection.chosen.channel };
  return {
    allowed: false,
    reason: blockedReason(selection.reasons),
    ...(selection.windowBlock ? { window: selection.windowBlock } : {}),
  };
}

export type PreflightResult =
  | { allowed: true; channel: Channel }
  | {
      allowed: false;
      reason: string;
      /**
       * Present when a channel passed suppression and consent and only a
       * sending_window rule held it back: the same intent may go out later.
       * Absent for every block that waiting would not fix.
       */
      window?: WindowBlock;
    };

/** The channels this tenant has a provider for. */
export async function configuredChannels(tx: Tx, tenantId: string): Promise<Channel[]> {
  return [...(await listChannelConfigs(tx, tenantId)).keys()];
}

/** The channels a template of this name exists for. */
export async function templateChannels(tx: Tx, tenantId: string, name: string): Promise<Channel[]> {
  const rows = await tx<{ channel: Channel }[]>`
    select channel from templates where tenant_id = ${tenantId} and name = ${name}
  `;
  return rows.map((r) => r.channel);
}

export type MessageStatus = {
  id: string;
  channel: string;
  status: MessageRow['status'];
  blockedReason: string | null;
  error: string | null;
  updatedAt: Date;
};

/** Where each of these messages stands now. For callers that keep message ids. */
export async function messageStatuses(tx: Tx, ids: string[]): Promise<Map<string, MessageStatus>> {
  if (ids.length === 0) return new Map();
  const rows = await tx<MessageStatus[]>`
    select id, channel, status, blocked_reason as "blockedReason", error, updated_at as "updatedAt"
    from messages where id = any(${ids}::uuid[])
  `;
  return new Map(rows.map((r) => [r.id, r]));
}

/** A template is unfit when the channel needs a piece the template has not got. */
export async function renderFor(
  channel: Channel,
  template: TemplateRow,
  variables: Record<string, unknown>,
): Promise<{ body: string; subject?: string }> {
  if (channel === 'email' && !template.subject) {
    throw new MessagingError(
      'template_unfit',
      422,
      `template ${template.name} has no subject, which email requires`,
    );
  }
  if (channel === 'whatsapp' && !template.provider_ref) {
    throw new MessagingError(
      'template_unfit',
      422,
      `template ${template.name} has no provider_ref, which whatsapp requires`,
    );
  }

  const body = await render(template.body, variables);
  if (!template.subject) return { body };
  return { body, subject: await render(template.subject, variables) };
}

/** A phone or email that is a company identifier says who we are writing to. */
async function companyForAddress(
  tx: Tx,
  channel: Channel,
  address: string,
): Promise<string | undefined> {
  const type = channel === 'email' ? 'email' : channel === 'telegram' ? null : 'phone';
  if (!type) return undefined;
  const company = await findByIdentifier(tx, type, address);
  return company?.id;
}

async function insertMessage(
  tx: Tx,
  input: {
    tenantId: string;
    channel: Channel;
    contact: ContactInput;
    address: string;
    region: string | null;
    purpose: Purpose;
    template: string;
    body: string;
    variables?: Record<string, unknown> | undefined;
    status: 'blocked' | 'queued';
    blockedReason?: string;
    fallbackChannels: Channel[];
    parentMessageId?: string | undefined;
    companyId?: string | undefined;
    campaignRunId?: string | undefined;
  },
): Promise<MessageRow> {
  const [row] = await tx<MessageRow[]>`
    insert into messages
      (tenant_id, channel, address, region, purpose, template_name, body, status,
       blocked_reason, contact, variables, fallback_channels, parent_message_id, company_id,
       campaign_run_id)
    values (${input.tenantId}, ${input.channel}, ${input.address}, ${input.region},
            ${input.purpose}, ${input.template}, ${input.body}, ${input.status},
            ${input.blockedReason ?? null},
            ${tx.json(input.contact as never)},
            ${tx.json((input.variables ?? {}) as never)},
            ${input.fallbackChannels},
            ${input.parentMessageId ?? null},
            ${input.companyId ?? null},
            ${input.campaignRunId ?? null})
    returning *
  `;
  if (!row) throw new Error('send inserted no message row');
  return row;
}

export function openConfig(row: ChannelConfigRow): ProviderConfig {
  return decrypt<ProviderConfig>({
    ciphertext: row.config_ciphertext,
    iv: row.config_iv,
    tag: row.config_tag,
  });
}
