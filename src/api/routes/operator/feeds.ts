import { db } from '../../../db/client.js';
import type { Window } from './shared.js';
import { typeFilter } from './shared.js';

/**
 * Cross-tenant reads. Every one carries tenantId and tenantName, because an
 * operator looking at a list of messages from every tenant needs to know whose
 * they are without a second call.
 */

export async function events(input: {
  tenantId?: string | undefined;
  type?: string | undefined;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  window: Window;
  limit: number;
  cursor?: string | undefined;
}) {
  const sql = db();
  const { exact, prefix } = typeFilter(input.type);

  return sql<Record<string, unknown>[]>`
    select e.id::text as id, e.type, e.tenant_id::text as "tenantId", t.name as "tenantName",
           e.subject_type as "subjectType", e.subject_id as "subjectId",
           e.payload, e.occurred_at as "occurredAt"
    from events e
    join tenants t on t.id = e.tenant_id
    where e.occurred_at >= ${input.window.since} and e.occurred_at < ${input.window.until}
      ${input.tenantId ? sql`and e.tenant_id = ${input.tenantId}` : sql``}
      ${exact ? sql`and e.type = ${exact}` : sql``}
      ${prefix ? sql`and e.type like ${`${prefix}%`}` : sql``}
      ${input.subjectType ? sql`and e.subject_type = ${input.subjectType}` : sql``}
      ${input.subjectId ? sql`and e.subject_id = ${input.subjectId}` : sql``}
      ${input.cursor ? sql`and e.id < ${input.cursor}` : sql``}
    order by e.id desc
    limit ${input.limit}
  `;
}

export async function oneEvent(id: string) {
  const [row] = await db()<Record<string, unknown>[]>`
    select e.id::text as id, e.type, e.tenant_id::text as "tenantId", t.name as "tenantName",
           e.subject_type as "subjectType", e.subject_id as "subjectId",
           e.payload, e.occurred_at as "occurredAt"
    from events e join tenants t on t.id = e.tenant_id
    where e.id = ${id}
  `;
  return row;
}

export async function messages(input: {
  tenantId?: string | undefined;
  status?: string | undefined;
  channel?: string | undefined;
  provider?: string | undefined;
  companyId?: string | undefined;
  address?: string | undefined;
  window: Window;
  limit: number;
  cursor?: string | undefined;
}) {
  const sql = db();

  const rows = await sql<Record<string, unknown>[]>`
    select m.id::text as id, m.tenant_id::text as "tenantId", t.name as "tenantName",
           m.channel, m.address, m.region, m.purpose, m.template_name as "template",
           m.status, m.blocked_reason as "blockedReason", m.error,
           m.provider, m.provider_message_id as "providerMessageId",
           m.company_id::text as "companyId", c.name as "companyName",
           m.parent_message_id::text as "parentMessageId", m.fallback_channels as "fallbackChannels",
           m.created_at as "createdAt", m.updated_at as "updatedAt"
    from messages m
    join tenants t on t.id = m.tenant_id
    left join companies c on c.id = m.company_id
    where m.created_at >= ${input.window.since} and m.created_at < ${input.window.until}
      ${input.tenantId ? sql`and m.tenant_id = ${input.tenantId}` : sql``}
      ${input.status ? sql`and m.status = ${input.status}` : sql``}
      ${input.channel ? sql`and m.channel = ${input.channel}` : sql``}
      ${input.provider ? sql`and m.provider = ${input.provider}` : sql``}
      ${input.companyId ? sql`and m.company_id = ${input.companyId}` : sql``}
      ${input.address ? sql`and m.address = ${input.address}` : sql``}
      ${input.cursor ? sql`and m.created_at < (select created_at from messages where id = ${input.cursor})` : sql``}
    order by m.created_at desc, m.id desc
    limit ${input.limit}
  `;

  // One row should tell the whole story, so each carries its own events in
  // order rather than making the operator open every message to see what
  // happened to it.
  return withTimelines(rows);
}

async function withTimelines(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const ids = rows.map((r) => r['id'] as string);
  if (ids.length === 0) return rows;

  const timeline = await db()<{ subject_id: string; type: string; occurred_at: Date }[]>`
    select subject_id, type, occurred_at from events
    where subject_type = 'message' and subject_id = any(${ids})
    order by id
  `;

  return rows.map((row) => ({
    ...row,
    timeline: timeline
      .filter((e) => e.subject_id === row['id'])
      .map((e) => ({ type: e.type, at: e.occurred_at })),
  }));
}

export async function oneMessage(id: string) {
  const [message] = await messagesById(id);
  if (!message) return undefined;

  const [events, reports, children, parent] = await Promise.all([
    db()<Record<string, unknown>[]>`
      select id::text as id, type, payload, occurred_at as "occurredAt" from events
      where subject_type = 'message' and subject_id = ${id} order by id
    `,
    // The provider's own words, kept exactly as they arrived.
    db()<Record<string, unknown>[]>`
      select id::text as id, type, payload, occurred_at as "occurredAt" from events
      where subject_type = 'message' and subject_id = ${id}
        and type in ('message.delivered', 'message.read', 'message.failed')
      order by id
    `,
    db()<Record<string, unknown>[]>`
      select id::text as id, channel, status, blocked_reason as "blockedReason"
      from messages where parent_message_id = ${id} order by created_at
    `,
    (message['parentMessageId'] as string | null)
      ? db()<Record<string, unknown>[]>`
          select id::text as id, channel, status from messages
          where id = ${message['parentMessageId'] as string}
        `
      : Promise.resolve([]),
  ]);

  return { message, events, deliveryReports: reports, fallbackChildren: children, parent: parent[0] ?? null };
}

async function messagesById(id: string) {
  return db()<Record<string, unknown>[]>`
    select m.id::text as id, m.tenant_id::text as "tenantId", t.name as "tenantName",
           m.channel, m.address, m.region, m.purpose, m.template_name as "template",
           m.body, m.variables, m.contact,
           m.status, m.blocked_reason as "blockedReason", m.error,
           m.provider, m.provider_message_id as "providerMessageId",
           m.company_id::text as "companyId", c.name as "companyName",
           m.parent_message_id::text as "parentMessageId",
           m.fallback_channels as "fallbackChannels",
           m.created_at as "createdAt", m.updated_at as "updatedAt"
    from messages m
    join tenants t on t.id = m.tenant_id
    left join companies c on c.id = m.company_id
    where m.id = ${id}
  `;
}

export async function redemptions(input: {
  tenantId?: string | undefined;
  status?: string | undefined;
  promocodeId?: string | undefined;
  window: Window;
  limit: number;
  cursor?: string | undefined;
}) {
  const sql = db();
  return sql<Record<string, unknown>[]>`
    select r.id::text as id, r.tenant_id::text as "tenantId", t.name as "tenantName",
           r.promocode_id::text as "promocodeId", p.code, r.buyer_ref as "buyerRef",
           r.buyer_company_ref as "buyerCompanyRef", r.order_ref as "orderRef",
           r.currency, r.discount_amount::text as "discountAmount", r.status,
           r.holds, r.reserved_at as "reservedAt", r.settled_at as "settledAt",
           r.released_at as "releasedAt", r.release_reason as "releaseReason",
           r.expires_at as "expiresAt"
    from redemptions r
    join tenants t on t.id = r.tenant_id
    join promocodes p on p.id = r.promocode_id
    where r.reserved_at >= ${input.window.since} and r.reserved_at < ${input.window.until}
      ${input.tenantId ? sql`and r.tenant_id = ${input.tenantId}` : sql``}
      ${input.status ? sql`and r.status = ${input.status}` : sql``}
      ${input.promocodeId ? sql`and r.promocode_id = ${input.promocodeId}` : sql``}
      ${input.cursor ? sql`and r.reserved_at < (select reserved_at from redemptions where id = ${input.cursor})` : sql``}
    order by r.reserved_at desc, r.id desc
    limit ${input.limit}
  `;
}

export async function invites(input: {
  tenantId?: string | undefined;
  status?: string | undefined;
  window: Window;
  limit: number;
  cursor?: string | undefined;
}) {
  const sql = db();
  return sql<Record<string, unknown>[]>`
    select i.id::text as id, i.tenant_id::text as "tenantId", t.name as "tenantName",
           i.company_id::text as "companyId", c.name as "companyName",
           i.message_id::text as "messageId", i.status, i.accepted_ref as "acceptedRef",
           i.finder_run_id::text as "finderRunId",
           i.created_at as "createdAt", i.accepted_at as "acceptedAt",
           i.expires_at as "expiresAt"
    from invites i
    join tenants t on t.id = i.tenant_id
    join companies c on c.id = i.company_id
    where i.created_at >= ${input.window.since} and i.created_at < ${input.window.until}
      ${input.tenantId ? sql`and i.tenant_id = ${input.tenantId}` : sql``}
      ${input.status ? sql`and i.status = ${input.status}` : sql``}
      ${input.cursor ? sql`and i.created_at < (select created_at from invites where id = ${input.cursor})` : sql``}
    order by i.created_at desc, i.id desc
    limit ${input.limit}
  `;
}

export async function companies(input: {
  q?: string | undefined;
  country?: string | undefined;
  onPlatform?: boolean | undefined;
  limit: number;
  cursor?: string | undefined;
}) {
  const sql = db();
  const { normalizeName } = await import('../../../spine/registry/index.js');
  const q = input.q ? normalizeName(input.q) : null;

  return sql<Record<string, unknown>[]>`
    select c.id::text as id, c.name, c.country, c.on_platform_ref as "onPlatformRef",
           c.on_platform_at as "onPlatformAt", c.created_at as "createdAt",
           p.buys, p.sells, p.sector, p.city
    from companies c
    left join company_profiles p on p.company_id = c.id
    where c.merged_into is null
      ${q ? sql`and c.name_normalized % ${q}` : sql``}
      ${input.country ? sql`and c.country = ${input.country}` : sql``}
      ${input.onPlatform === true ? sql`and c.on_platform_ref is not null` : sql``}
      ${input.onPlatform === false ? sql`and c.on_platform_ref is null` : sql``}
      ${input.cursor ? sql`and c.created_at < (select created_at from companies where id = ${input.cursor})` : sql``}
    order by c.created_at desc, c.id desc
    limit ${input.limit}
  `;
}

export async function webhookDeliveries(input: {
  status?: string | undefined;
  tenantId?: string | undefined;
  endpointId?: string | undefined;
  window: Window;
  limit: number;
  cursor?: string | undefined;
}) {
  const sql = db();
  return sql<Record<string, unknown>[]>`
    select d.id::text as id, d.status, d.attempt,
           d.last_status_code as "lastStatusCode", d.last_error as "lastError",
           d.next_attempt_at as "nextAttemptAt", d.delivered_at as "deliveredAt",
           d.created_at as "createdAt",
           d.endpoint_id::text as "endpointId", e.url,
           e.tenant_id::text as "tenantId", t.name as "tenantName",
           d.event_id::text as "eventId", ev.type as "eventType"
    from webhook_deliveries d
    join webhook_endpoints e on e.id = d.endpoint_id
    left join tenants t on t.id = e.tenant_id
    join events ev on ev.id = d.event_id
    where d.created_at >= ${input.window.since} and d.created_at < ${input.window.until}
      ${input.status ? sql`and d.status = ${input.status}` : sql``}
      ${input.tenantId ? sql`and e.tenant_id = ${input.tenantId}` : sql``}
      ${input.endpointId ? sql`and d.endpoint_id = ${input.endpointId}` : sql``}
      ${input.cursor ? sql`and d.id < ${input.cursor}` : sql``}
    order by d.id desc
    limit ${input.limit}
  `;
}
