import { db } from '../../../db/client.js';
import { usdPerCredit } from '../../../modules/discovery/index.js';
import { queueState } from '../webhook-endpoints.js';
import { campaignSection } from './campaigns.js';
import * as spend from './search-spend.js';
import type { Window } from './shared.js';

/**
 * One query per section, nothing cached. An operator looking at this wants to
 * know what is true now, and a cache is a way of being confidently wrong.
 */
export async function overview(window: Window) {
  const sql = db();

  const [health, queue, messages, blockedReasons, tenants, webhooks, reservations, discovery, campaigns, serper] =
    await Promise.all([
      healthSection(),
      queueSection(window),
      countsBy(sql`
        select status as key, count(*)::text as n from messages
        where created_at >= ${window.since} and created_at < ${window.until}
        group by status
      `),
      // Not messages.blocked_reason: since channel selection that column says
      // `no_channel` for almost every block, which tells an operator nothing.
      // The reason per channel — no_consent, suppressed, rule:<name> — is in
      // the message.blocked event's payload, which is what is worth counting.
      countsBy(sql`
        select reason as key, count(*)::text as n
        from events e, jsonb_each_text(coalesce(e.payload -> 'channels', '{}'::jsonb)) as r(channel, reason)
        where e.type = 'message.blocked'
          and e.occurred_at >= ${window.since} and e.occurred_at < ${window.until}
        group by reason
      `),
      tenantSection(window),
      countsBy(sql`
        select status as key, count(*)::text as n from webhook_deliveries
        where status in ('pending', 'failed')
        group by status
      `),
      reservationSection(),
      discoverySection(window),
      campaignSection(window),
      serperSection(window),
    ]);

  return {
    asOf: new Date().toISOString(),
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    health,
    queue,
    messages,
    blockedReasons,
    tenants,
    webhooks,
    reservations,
    discovery,
    campaigns,
    serper,
  };
}

async function healthSection() {
  let dbUp = true;
  try {
    await db()`select 1`;
  } catch {
    dbUp = false;
  }
  return {
    db: dbUp,
    boss: dbUp ? await queueState() : 'unknown',
    version: process.env['npm_package_version'] ?? '0.1.0',
  };
}

/**
 * Straight from pg-boss's own tables, with its column names read off the
 * installed schema rather than assumed. Completed jobs move to `archive` after
 * their retention, so the window count reads both.
 */
async function queueSection(window: Window) {
  const live = await db()<{ name: string; state: string; n: string }[]>`
    select name, state::text as state, count(*)::text as n
    from pgboss.job
    group by name, state
  `;
  const done = await db()<{ name: string; n: string }[]>`
    select name, count(*)::text as n from (
      select name, completed_on from pgboss.job
      where state = 'completed' and completed_on >= ${window.since}
      union all
      select name, completed_on from pgboss.archive
      where state = 'completed' and completed_on >= ${window.since}
    ) completed
    group by name
  `;

  const names = [...new Set([...live.map((r) => r.name), ...done.map((r) => r.name)])].sort();
  return names.map((name) => {
    const of = (state: string) =>
      Number(live.find((r) => r.name === name && r.state === state)?.n ?? 0);
    return {
      name,
      created: of('created'),
      active: of('active'),
      retry: of('retry'),
      failed: of('failed'),
      cancelled: of('cancelled'),
      completedInWindow: Number(done.find((r) => r.name === name)?.n ?? 0),
    };
  });
}

async function tenantSection(window: Window) {
  return db()<Record<string, string>[]>`
    select
      t.id::text as "tenantId",
      t.name as "tenantName",
      coalesce(m.queued, '0') as queued, coalesce(m.sent, '0') as sent,
      coalesce(m.delivered, '0') as delivered, coalesce(m.read, '0') as read,
      coalesce(m.failed, '0') as failed, coalesce(m.blocked, '0') as blocked,
      coalesce(i.sent, '0') as "invitesSent", coalesce(i.accepted, '0') as "invitesAccepted",
      coalesce(r.reserved, '0') as "redemptionsReserved",
      coalesce(r.settled, '0') as "redemptionsSettled",
      coalesce(r.released, '0') as "redemptionsReleased",
      coalesce(w.failed, '0') as "webhookFailures"
    from tenants t
    left join lateral (
      select
        count(*) filter (where status = 'queued')::text as queued,
        count(*) filter (where status = 'sent')::text as sent,
        count(*) filter (where status = 'delivered')::text as delivered,
        count(*) filter (where status = 'read')::text as read,
        count(*) filter (where status = 'failed')::text as failed,
        count(*) filter (where status = 'blocked')::text as blocked
      from messages
      where tenant_id = t.id and created_at >= ${window.since} and created_at < ${window.until}
    ) m on true
    left join lateral (
      select
        count(*) filter (where status = 'sent')::text as sent,
        count(*) filter (where status = 'accepted')::text as accepted
      from invites
      where tenant_id = t.id and created_at >= ${window.since} and created_at < ${window.until}
    ) i on true
    left join lateral (
      select
        count(*) filter (where status = 'reserved')::text as reserved,
        count(*) filter (where status = 'settled')::text as settled,
        count(*) filter (where status = 'released')::text as released
      from redemptions
      where tenant_id = t.id and reserved_at >= ${window.since} and reserved_at < ${window.until}
    ) r on true
    left join lateral (
      select count(*) filter (where d.status = 'failed')::text as failed
      from webhook_deliveries d
      join webhook_endpoints e on e.id = d.endpoint_id
      where e.tenant_id = t.id
    ) w on true
    order by t.created_at
  `.then((rows) =>
    rows.map((r) => ({
      tenantId: r['tenantId'],
      tenantName: r['tenantName'],
      messages: {
        queued: Number(r['queued']),
        sent: Number(r['sent']),
        delivered: Number(r['delivered']),
        read: Number(r['read']),
        failed: Number(r['failed']),
        blocked: Number(r['blocked']),
      },
      invites: { sent: Number(r['invitesSent']), accepted: Number(r['invitesAccepted']) },
      redemptions: {
        reserved: Number(r['redemptionsReserved']),
        settled: Number(r['redemptionsSettled']),
        released: Number(r['redemptionsReleased']),
      },
      webhookFailures: Number(r['webhookFailures']),
    })),
  );
}

async function reservationSection() {
  const [row] = await db()<{ open: string; soon: string }[]>`
    select
      count(*) filter (where status = 'reserved')::text as open,
      count(*) filter (
        where status = 'reserved' and expires_at <= now() + interval '15 minutes'
      )::text as soon
    from redemptions
  `;
  return { open: Number(row?.open ?? 0), expiringWithin15m: Number(row?.soon ?? 0) };
}

async function discoverySection(window: Window) {
  const [row] = await db()<{ searches: string; from_search: string }[]>`
    select
      (select count(*) from finder_runs
       where created_at >= ${window.since} and created_at < ${window.until})::text as searches,
      (select count(*) from invites
       where finder_run_id is not null
         and created_at >= ${window.since} and created_at < ${window.until})::text as from_search
  `;
  return {
    searches: Number(row?.searches ?? 0),
    invitesFromSearch: Number(row?.from_search ?? 0),
  };
}

/**
 * What Serper cost, from the per-query events: this window and all time,
 * with the averages the operator asks for, then the window broken down.
 */
async function serperSection(window: Window) {
  const [inWindow, allTime, byKind, byCountry, byTenant, topSearches, series] = await Promise.all([
    spend.totals(window),
    spend.totals(null),
    spend.byKind(window),
    spend.byCountry(window),
    spend.byTenant(window),
    spend.topSearches(window),
    spend.series(window),
  ]);
  return { usdPerCredit: usdPerCredit(), window: inWindow, allTime, byKind, byCountry, byTenant, topSearches, series };
}

async function countsBy(query: Promise<{ key: string; n: string }[]>): Promise<Record<string, number>> {
  const rows = await query;
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
}
