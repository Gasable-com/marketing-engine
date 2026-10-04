import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { replay } from '../../../modules/webhooks/index.js';
import { db } from '../../../db/client.js';
import * as campaignFeeds from './campaigns.js';
import * as feeds from './feeds.js';
import { jobs, oneJob, retryJob, schedules } from './jobs.js';
import { metrics } from './metrics.js';
import { overview } from './overview.js';
import * as promoFeeds from './promocodes.js';
import { listQuery, page, resolveWindow, windowQuery } from './shared.js';
import {
  HEARTBEAT_MS,
  MAX_CLIENTS,
  matches,
  replaySince,
  tenantName,
  watch,
  watcherCount,
} from './stream.js';

/**
 * The platform read side. Mounted under /internal, so the token middleware in
 * routes/internal.ts already guards it — a tenant JWT is not enough here.
 *
 * Read-only apart from two things an operator genuinely needs: retrying a
 * failed job and replaying a failed delivery.
 *
 * This is the one place that reads across every module's tables. A dashboard
 * is inherently cross-cutting; it owns nothing and writes nothing, so nothing
 * about a module's independence changes.
 */
export const operator = new Hono();

const base = listQuery.merge(windowQuery);

operator.get('/internal/overview', async (c) => {
  const w = windowQuery.safeParse(c.req.query());
  if (!w.success) return c.json({ error: 'invalid query', detail: w.error.issues }, 400);
  return c.json(await overview(resolveWindow(w.data)));
});

operator.get('/internal/tenants', async (c) => {
  const q = listQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const window = resolveWindow({});
  const full = await overview(window);
  const counts = new Map(full.tenants.map((t) => [t.tenantId, t]));

  const sql = db();
  const rows = await sql<Record<string, unknown>[]>`
    select id::text as id, name, external_ref as "externalRef", created_at as "createdAt"
    from tenants
    where true ${q.data.cursor ? sql`and created_at < (select created_at from tenants where id = ${q.data.cursor})` : sql``}
    order by created_at desc, id desc
    limit ${q.data.limit}
  `;

  return c.json(
    page(
      rows.map((r) => ({ ...r, ...(counts.get(r['id'] as string) ?? {}) })),
      q.data.limit,
    ),
  );
});

operator.get('/internal/tenants/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const [tenant] = await db()<Record<string, unknown>[]>`
    select id::text as id, name, external_ref as "externalRef", created_at as "createdAt"
    from tenants where id = ${id.data}
  `;
  if (!tenant) return c.json({ error: 'not found' }, 404);

  const [channels, templates, rules, endpoints, day, week, month] = await Promise.all([
    // Redacted exactly as the tenant's own GET redacts it: never the config.
    db()<Record<string, unknown>[]>`
      select channel, provider, sender, unsubscribe_text as "unsubscribeText",
             true as configured, updated_at as "updatedAt"
      from tenant_channel_configs where tenant_id = ${id.data} order by channel
    `,
    db()<Record<string, unknown>[]>`
      select name, channel, updated_at as "updatedAt" from templates
      where tenant_id = ${id.data} order by name
    `,
    db()<{ kind: string; n: string }[]>`
      select kind, count(*)::text as n from rules
      where tenant_id = ${id.data} group by kind
    `,
    db()<Record<string, unknown>[]>`
      select id::text as id, url, event_types as "eventTypes", active,
             created_at as "createdAt"
      from webhook_endpoints where tenant_id = ${id.data} order by created_at
    `,
    tenantCounts(id.data, '24h'),
    tenantCounts(id.data, '7d'),
    tenantCounts(id.data, '30d'),
  ]);

  return c.json({
    tenant,
    channels,
    templates,
    rules: Object.fromEntries(rules.map((r) => [r.kind, Number(r.n)])),
    webhooks: endpoints,
    counts: { '24h': day, '7d': week, '30d': month },
  });
});

async function tenantCounts(tenantId: string, window: '24h' | '7d' | '30d') {
  const w = resolveWindow({ window });
  const full = await overview(w);
  const row = full.tenants.find((t) => t.tenantId === tenantId);
  return row
    ? { messages: row.messages, invites: row.invites, redemptions: row.redemptions }
    : null;
}

operator.get('/internal/events', async (c) => {
  const q = base
    .extend({
      tenantId: z.string().uuid().optional(),
      type: z.string().max(100).optional(),
      subjectType: z.string().max(100).optional(),
      subjectId: z.string().max(200).optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const items = await feeds.events({ ...q.data, window: resolveWindow(q.data, '7d') });
  return c.json(page(items, q.data.limit));
});

operator.get('/internal/events/:id', async (c) => {
  const row = await feeds.oneEvent(c.req.param('id'));
  return row ? c.json({ event: row }) : c.json({ error: 'not found' }, 404);
});

operator.get('/internal/messages', async (c) => {
  const q = base
    .extend({
      tenantId: z.string().uuid().optional(),
      status: z.string().max(30).optional(),
      channel: z.string().max(30).optional(),
      provider: z.string().max(50).optional(),
      companyId: z.string().uuid().optional(),
      address: z.string().max(320).optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const items = await feeds.messages({ ...q.data, window: resolveWindow(q.data, '7d') });
  return c.json(page(items, q.data.limit));
});

operator.get('/internal/messages/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const detail = await feeds.oneMessage(id.data);
  return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
});

operator.get('/internal/redemptions', async (c) => {
  const q = base
    .extend({
      tenantId: z.string().uuid().optional(),
      status: z.string().max(30).optional(),
      promocodeId: z.string().uuid().optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const items = await feeds.redemptions({ ...q.data, window: resolveWindow(q.data, '30d') });
  return c.json(page(items, q.data.limit));
});

operator.get('/internal/invites', async (c) => {
  const q = base
    .extend({ tenantId: z.string().uuid().optional(), status: z.string().max(30).optional() })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const items = await feeds.invites({ ...q.data, window: resolveWindow(q.data, '30d') });
  return c.json(page(items, q.data.limit));
});

operator.get('/internal/companies', async (c) => {
  const q = listQuery
    .extend({
      q: z.string().min(1).max(200).optional(),
      country: z.string().length(2).optional(),
      onPlatform: z.enum(['true', 'false']).optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const { onPlatform, ...rest } = q.data;
  const items = await feeds.companies({
    ...rest,
    ...(onPlatform ? { onPlatform: onPlatform === 'true' } : {}),
  });
  return c.json(page(items, q.data.limit));
});

operator.get('/internal/campaigns', async (c) => {
  const q = listQuery
    .extend({ tenantId: z.string().uuid().optional(), status: z.string().max(30).optional() })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const items = await campaignFeeds.campaigns(q.data);
  return c.json(page(items, q.data.limit));
});

operator.get('/internal/campaigns/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const detail = await campaignFeeds.oneCampaign(id.data);
  return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
});

operator.get('/internal/campaigns/:id/runs/:runId/recipients', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const runId = z.string().uuid().safeParse(c.req.param('runId'));
  if (!id.success || !runId.success) return c.json({ error: 'not found' }, 404);
  const q = listQuery
    .extend({ state: z.enum(['pending', 'queued', 'blocked', 'skipped']).optional() })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const items = await campaignFeeds.recipients({ campaignId: id.data, runId: runId.data, ...q.data });
  return c.json(page(items, q.data.limit));
});

operator.get('/internal/promocodes', async (c) => {
  const q = listQuery
    .extend({
      tenantId: z.string().uuid().optional(),
      status: z.string().max(30).optional(),
      code: z.string().min(1).max(100).optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const items = await promoFeeds.promocodes(q.data);
  return c.json(page(items, q.data.limit));
});

operator.get('/internal/promocodes/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const promocode = await promoFeeds.onePromocode(id.data);
  return promocode ? c.json({ promocode }) : c.json({ error: 'not found' }, 404);
});

operator.get('/internal/webhook-deliveries', async (c) => {
  const q = base
    .extend({
      status: z.string().max(30).optional(),
      tenantId: z.string().uuid().optional(),
      endpointId: z.string().uuid().optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const items = await feeds.webhookDeliveries({ ...q.data, window: resolveWindow(q.data, '7d') });
  return c.json(page(items, q.data.limit));
});

operator.post('/internal/webhook-deliveries/:id/replay', async (c) => {
  const id = c.req.param('id');
  const [owner] = await db()<{ tenant_id: string | null }[]>`
    select e.tenant_id::text as tenant_id
    from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
    where d.id = ${id}
  `;
  if (!owner) return c.json({ error: 'not found' }, 404);

  // The platform endpoint has no tenant, so replay it directly rather than
  // through the tenant-scoped path.
  const row = owner.tenant_id
    ? await replay(owner.tenant_id, id)
    : await replayPlatform(id);

  return c.json({ delivery: row }, 202);
}); 

async function replayPlatform(id: string) {
  const { enqueue } = await import('../../../jobs/queue.js');
  return db().begin(async (tx) => {
    const [row] = await tx<Record<string, unknown>[]>`
      update webhook_deliveries
      set status = 'pending', attempt = 0, next_attempt_at = now(), last_error = null
      where id = ${id}
      returning *
    `;
    await enqueue(tx as never, 'webhook.deliver', { deliveryId: id });
    return row!;
  });
}

operator.get('/internal/jobs', async (c) => {
  const q = listQuery
    .extend({ name: z.string().max(100).optional(), state: z.string().max(30).optional() })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  const items = await jobs(q.data);
  return c.json(page(items, q.data.limit));
});

operator.get('/internal/jobs/:id', async (c) => {
  const row = await oneJob(c.req.param('id'));
  return row ? c.json({ job: row }) : c.json({ error: 'not found' }, 404);
});

operator.post('/internal/jobs/:id/retry', async (c) => {
  const result = await retryJob(c.req.param('id'));
  if (result.ok) return c.json({ retried: result.id });

  return result.reason === 'not_found'
    ? c.json({ error: 'not found' }, 404)
    : c.json({ error: 'not_failed', message: `job is ${result.state}, not failed` }, 409);
});

operator.get('/internal/schedules', async (c) => c.json({ schedules: await schedules() }));

operator.get('/internal/metrics', async (c) => {
  const q = windowQuery
    .extend({
      series: z.enum(['messages', 'events', 'redemptions', 'searches']),
      bucket: z.enum(['hour', 'day']).default('hour'),
      tenantId: z.string().uuid().optional(),
      groupBy: z.enum(['status', 'channel', 'type']).optional(),
    })
    .safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'invalid query', detail: q.error.issues }, 400);

  return c.json(await metrics({ ...q.data, window: resolveWindow(q.data, '7d') }));
});

operator.get('/internal/stream', async (c) => {
  if (watcherCount() >= MAX_CLIENTS) {
    return c.json(
      { error: 'too_many_streams', message: `at most ${MAX_CLIENTS} concurrent streams` },
      503,
    );
  }

  const filters = {
    ...(c.req.query('tenantId') ? { tenantId: c.req.query('tenantId') } : {}),
    ...(c.req.query('type') ? { type: c.req.query('type') } : {}),
  };
  const lastEventId = c.req.header('Last-Event-ID');

  return streamSSE(c, async (stream) => {
    // Hand whatever arrived while the client was away, then go live. Buffer
    // anything the socket produces during the replay so nothing is lost in the
    // gap between the two.
    const pending: string[] = [];
    let live = false;

    const stop = await watch((event) => {
      if (!matches(event, filters)) return;
      if (!live) {
        pending.push(JSON.stringify(event));
        return;
      }
      void send(event);
    });

    const send = async (event: { id: string; type: string }) =>
      stream.writeSSE({
        id: String(event.id),
        event: event.type,
        data: JSON.stringify(event),
      });

    stream.onAbort(() => {
      void stop();
    });

    try {
      if (lastEventId) {
        for (const missed of await replaySince(lastEventId, filters)) await send(missed);
      }

      live = true;
      for (const buffered of pending.splice(0)) {
        const event = JSON.parse(buffered) as { id: string; type: string };
        await send(event);
      }

      // A comment line keeps proxies from closing an idle connection.
      for (;;) {
        await stream.sleep(HEARTBEAT_MS);
        if (stream.aborted || stream.closed) break;
        await stream.writeln(': heartbeat');
      }
    } finally {
      await stop();
    }
  });
});

export { tenantName };
