import { db, withTenant } from '../../db/client.js';
import { isPromotional, type Channel, type Purpose } from '../../spine/contacts/normalize.js';
import { emit } from '../../spine/events/index.js';
import { adapterFor } from './adapters/index.js';
import { MessagingError } from './errors.js';
import {
  getChannelConfig,
  openConfig,
  renderFor,
  send,
  type ChannelConfigRow,
  type MessageRow,
  type TemplateRow,
  withContact,
} from './index.js';
import { unsubscribeUrlFor } from './unsubscribe.js';

/**
 * Send one queued message. Runs as the owning role, not withTenant: the worker
 * has no JWT, and it writes the status columns the API role cannot.
 *
 * Throws on provider failure so pg-boss retries. `finalAttempt` says this was
 * the last one, so the message is marked failed and its fallback, if any, is
 * started before the error propagates.
 */
export async function processSend(
  messageId: string,
  opts: { finalAttempt?: boolean } = {},
): Promise<void> {
  const [message] = await db()<MessageRow[]>`
    select * from messages where id = ${messageId}
  `;
  // The job commits with its message row, so a job without one is a bug.
  if (!message) throw new Error(`message ${messageId} has a job but no row`);
  if (message.status !== 'queued') return;

  const [config] = await db()<ChannelConfigRow[]>`
    select * from tenant_channel_configs
    where tenant_id = ${message.tenant_id} and channel = ${message.channel}
  `;
  if (!config) {
    await fail(message, `no provider configured for channel ${message.channel}`);
    return;
  }

  const adapter = adapterFor(config.provider, message.channel as Channel);
  if (!adapter) {
    // Retrying will not conjure an adapter, so fail now rather than three times.
    await fail(message, `no adapter for provider ${config.provider} on ${message.channel}`);
    return;
  }

  // WhatsApp fills its own approved template and email needs a subject line,
  // so both want the template row rather than just the rendered body.
  const [template] = await db()<TemplateRow[]>`
    select * from templates
    where tenant_id = ${message.tenant_id}
      and name = ${message.template_name} and channel = ${message.channel}
  `;

  let result: { providerMessageId: string; raw: unknown };
  try {
    result = await adapter.send({
      config: openConfig(config),
      messageId: message.id,
      to: message.address,
      body: message.body,
      sender: config.sender,
      purpose: message.purpose as Purpose,
      ...(template?.subject ? { subject: await subjectFor(message, template) } : {}),
      ...(template?.provider_ref ? { providerRef: template.provider_ref } : {}),
      variables: message.variables,
      ...(isPromotional(message.purpose as Purpose) && message.channel === 'email'
        ? { unsubscribeUrl: unsubscribeUrlFor(message.tenant_id, 'email', message.address) }
        : {}),
    });
  } catch (err) {
    if (opts.finalAttempt) await fail(message, (err as Error).message);
    throw err;
  }

  await db().begin(async (tx) => {
    await tx`
      update messages
      set status = 'sent', provider = ${config.provider},
          provider_message_id = ${result.providerMessageId}, updated_at = now()
      where id = ${message.id}
    `;
    await emit(tx, {
      tenantId: message.tenant_id,
      type: 'message.sent',
      subjectType: 'message',
      subjectId: message.id,
      payload: {
        provider: config.provider,
        providerMessageId: result.providerMessageId,
        channel: message.channel,
      },
    });
  });
}

async function subjectFor(message: MessageRow, template: TemplateRow): Promise<string> {
  const rendered = await renderFor(
    message.channel as Channel,
    template,
    withContact(message.variables, message.address),
  );
  return rendered.subject ?? '';
}

/** Mark the message failed, then hand the intent to the next channel if there is one. */
async function fail(message: MessageRow, error: string): Promise<void> {
  await db().begin(async (tx) => {
    await tx`
      update messages set status = 'failed', error = ${error}, updated_at = now()
      where id = ${message.id}
    `;
    await emit(tx, {
      tenantId: message.tenant_id,
      type: 'message.failed',
      subjectType: 'message',
      subjectId: message.id,
      payload: { error, channel: message.channel },
    });
  });

  await fallBack(message);
}

/**
 * Re-run the same intent on the next channel. A fallback of a fallback is fine;
 * a fallback of a blocked child is not, and there is none, because a blocked
 * message never reaches the worker.
 */
async function fallBack(message: MessageRow): Promise<void> {
  const [next, ...rest] = message.fallback_channels as Channel[];
  if (!next) return;

  // withTenant rather than the owning role: the tenant came from the message
  // row, and running the re-send under RLS keeps it scoped exactly as the API
  // path is.
  const child = await withTenant(message.tenant_id, async (tx) => {
    try {
      return await send(tx, {
        tenantId: message.tenant_id,
        contact: message.contact,
        channel: next,
        purpose: message.purpose as Purpose,
        template: message.template_name,
        variables: message.variables,
        parentMessageId: message.id,
        fallbackChannels: rest,
        ...(message.campaign_run_id ? { campaignRunId: message.campaign_run_id } : {}),
      });
    } catch (err) {
      // The next channel may not fit this template at all. Record that as a
      // blocked child and stop: there is nothing to retry.
      if (err instanceof MessagingError) {
        const [row] = await tx<MessageRow[]>`
          insert into messages
            (tenant_id, channel, address, purpose, template_name, body, status,
             blocked_reason, contact, variables, fallback_channels, parent_message_id)
          values (${message.tenant_id}, ${next}, ${''}, ${message.purpose},
                  ${message.template_name}, ${''}, 'blocked', ${err.code},
                  ${tx.json(message.contact as never)},
                  ${tx.json(message.variables as never)},
                  ${[]}, ${message.id})
          returning *
        `;
        await emit(tx, {
          tenantId: message.tenant_id,
          type: 'message.blocked',
          subjectType: 'message',
          subjectId: row!.id,
          payload: { reason: err.code, channel: next, parentMessageId: message.id },
        });
        return row!;
      }
      throw err;
    }
  });

  await db().begin((tx) =>
    emit(tx, {
      tenantId: message.tenant_id,
      type: 'message.fallback',
      subjectType: 'message',
      subjectId: message.id,
      payload: { childMessageId: child.id, channel: next, status: child.status },
    }),
  );
}

/**
 * Apply one provider callback. Runs as the owning role: a callback carries no
 * tenant, so the message row is what identifies it.
 */
export async function applyStatusReport(input: {
  provider: string;
  providerMessageId: string;
  status: 'delivered' | 'read' | 'failed' | 'unknown';
  raw: unknown;
}): Promise<void> {
  if (input.status === 'unknown') {
    console.warn(
      `webhook: ${input.provider} reported an unrecognised status for ${input.providerMessageId}`,
      input.raw,
    );
    return;
  }

  // `read` can only follow a delivery, the other two only a send. A report that
  // arrives twice, or out of order, matches nothing and so emits nothing.
  const from = input.status === 'read' ? ['sent', 'delivered'] : ['sent'];

  await db().begin(async (tx) => {
    const moved = await tx<MessageRow[]>`
      update messages set status = ${input.status}, updated_at = now()
      where provider = ${input.provider}
        and provider_message_id = ${input.providerMessageId}
        and status = any(${from})
      returning *
    `;

    const message = moved[0];
    if (!message) {
      console.warn(
        `webhook: ${input.provider} report for ${input.providerMessageId} matched nothing in flight`,
        input.raw,
      );
      return;
    }

    await emit(tx, {
      tenantId: message.tenant_id,
      type: `message.${input.status}`,
      subjectType: 'message',
      subjectId: message.id,
      payload: { provider: input.provider, providerMessageId: input.providerMessageId },
    });
  });
}

/**
 * Someone replied. There is no tenant on an inbound payload, so the most recent
 * message to that address says whose conversation it is. Recorded as an event
 * only: acting on a STOP reply is a rule for a later step.
 */
export async function applyInbound(input: {
  provider: string;
  channel: Channel;
  address: string;
  text: string;
  raw: unknown;
  tenantId?: string | undefined;
}): Promise<void> {
  let tenantId = input.tenantId;

  if (!tenantId) {
    const [last] = await db()<{ tenant_id: string }[]>`
      select tenant_id from messages
      where channel = ${input.channel} and address = ${input.address}
      order by created_at desc
      limit 1
    `;
    tenantId = last?.tenant_id;
  }

  if (!tenantId) {
    console.warn(
      `webhook: ${input.provider} inbound from ${input.address} matches no known conversation`,
    );
    return;
  }

  const owner = tenantId;
  await db().begin((tx) =>
    emit(tx, {
      tenantId: owner,
      type: 'message.replied',
      subjectType: 'contact',
      subjectId: `${input.channel}:${input.address}`,
      payload: { provider: input.provider, text: input.text },
    }),
  );
}
