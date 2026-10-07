import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { MAX_CLIENTS, forgetTenantNames, stopListening } from '../src/api/routes/operator/stream.js';
import { fanOut } from '../src/modules/webhooks/index.js';
import { emit } from '../src/spine/events/index.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();
const INTERNAL = process.env.INTERNAL_TOKEN!;

/** Seeded secrets. No operator response may ever contain one. */
const CHANNEL_SECRET = 'super-secret-provider-token';
let webhookSecret = '';

let tokenA: string;

function op(path: string, init: RequestInit = {}) {
  return app.fetch(
    new Request(`http://engine.test${path}`, {
      ...init,
      headers: { 'X-Internal-Token': INTERNAL, ...(init.headers ?? {}) },
    }),
  );
}

function tenant(path: string, init: RequestInit = {}, token = tokenA) {
  return app.fetch(
    new Request(`http://engine.test${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    }),
  );
}

const json = (body: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function fanOutPending(): Promise<void> {
  const events = await db()<{ id: string }[]>`
    select e.id::text as id from events e
    where not exists (select 1 from webhook_deliveries d where d.event_id = e.id)
    order by e.id
  `;
  for (const event of events) await fanOut(event.id);
}

beforeAll(async () => {
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
});

afterAll(async () => {
  await stopListening();
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  forgetTenantNames();
  await db()`delete from pgboss.job where name like 'webhook.%' or name = 'message.send'`;
});

describe('authentication', () => {
  it('refuses a tenant JWT and accepts the internal token', async () => {
    const withJwt = await app.fetch(
      new Request('http://engine.test/internal/overview', {
        headers: { Authorization: `Bearer ${tokenA}` },
      }),
    );
    expect(withJwt.status).toBe(401);

    expect((await op('/internal/overview')).status).toBe(200);
  });
});

/** Two tenants with a mix of everything the overview counts. */
async function seed(): Promise<{ messageId: string; deliveryId: string }> {
  await tenant('/v1/channels/sms', {
    method: 'PUT',
    ...json({
      provider: 'fake',
      sender: 'ACME',
      unsubscribeText: 'Reply STOP',
      config: { token: CHANNEL_SECRET },
    }),
  });
  await tenant('/v1/templates/hello', { method: 'PUT', ...json({ channel: 'sms', body: 'Hi' }) });

  const hook = await tenant('/v1/webhooks', {
    method: 'POST',
    ...json({ url: 'http://127.0.0.1:9/never' }),
  });
  webhookSecret = (await body<{ secret: string }>(hook)).secret;

  // One queued message, then statuses written straight on so the overview has
  // something of every kind to count.
  const sent = await tenant('/v1/messages', {
    method: 'POST',
    ...json({
      contact: { phone: '+966501234567' },
      channel: 'sms',
      purpose: 'transactional',
      template: 'hello',
    }),
  });
  const messageId = (await body<{ message: { id: string } }>(sent)).message.id;

  for (const [status, phone] of [
    ['sent', '+966501111111'],
    ['delivered', '+966502222222'],
    ['failed', '+966503333333'],
  ] as const) {
    const res = await tenant('/v1/messages', {
      method: 'POST',
      ...json({
        contact: { phone },
        channel: 'sms',
        purpose: 'transactional',
        template: 'hello',
      }),
    });
    const id = (await body<{ message: { id: string } }>(res)).message.id;
    await db()`update messages set status = ${status} where id = ${id}`;
  }

  // Two blocked, for two different reasons.
  await tenant('/v1/messages', {
    method: 'POST',
    ...json({
      contact: { phone: '+966504444444' },
      channel: 'sms',
      purpose: 'marketing',
      template: 'hello',
      at: '2026-03-02T07:00:00.000Z',
    }),
  });
  await tenant('/v1/suppression', {
    method: 'POST',
    ...json({ channel: 'sms', address: '+966505555555', reason: 'complaint' }),
  });
  await tenant('/v1/messages', {
    method: 'POST',
    ...json({
      contact: { phone: '+966505555555' },
      channel: 'sms',
      purpose: 'transactional',
      template: 'hello',
    }),
  });

  // One reservation expiring soon.
  await tenant('/v1/promocodes', {
    method: 'POST',
    ...json({
      code: 'OPS10',
      currency: 'SAR',
      discount: { type: 'percent', value: 1000, maxDiscount: 5000 },
      funders: [{ party: 'platform', share: 1 }],
    }),
  });
  await tenant('/v1/redemptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'ops-1' },
    body: JSON.stringify({
      code: 'OPS10',
      buyerRef: 'b-1',
      cart: { currency: 'SAR', subtotal: 80000, items: [] },
      orderRef: 'ops-order-1',
    }),
  });
  await db()`update redemptions set expires_at = now() + interval '10 minutes'`;

  // Tests run the queue without workers, so nothing processes the fan-out job.
  // Drive it here so there are deliveries to look at.
  await fanOutPending();

  // One failed delivery.
  const [delivery] = await db()<{ id: string }[]>`
    select d.id::text as id from webhook_deliveries d limit 1
  `;
  await db()`update webhook_deliveries set status = 'failed', attempt = 5 where id = ${delivery!.id}`;

  return { messageId, deliveryId: delivery!.id };
}

describe('overview', () => {
  it('counts every section against what was seeded', async () => {
    await seed();

    const view = await body<{
      health: { db: boolean };
      queue: { name: string; created: number }[];
      messages: Record<string, number>;
      blockedReasons: Record<string, number>;
      tenants: { tenantId: string; tenantName: string; messages: Record<string, number> }[];
      webhooks: Record<string, number>;
      reservations: { open: number; expiringWithin15m: number };
      discovery: { searches: number };
    }>(await op('/internal/overview?window=24h'));

    expect(view.health.db).toBe(true);
    expect(view.messages['queued']).toBe(1);
    expect(view.messages['sent']).toBe(1);
    expect(view.messages['delivered']).toBe(1);
    expect(view.messages['failed']).toBe(1);
    expect(view.messages['blocked']).toBe(2);

    // Both messages were blocked, for different per-channel reasons.
    expect(view.blockedReasons['no_consent']).toBe(1);
    expect(view.blockedReasons['suppressed']).toBe(1);

    expect(view.reservations).toEqual({ open: 1, expiringWithin15m: 1 });
    expect(view.webhooks['failed']).toBe(1);

    const a = view.tenants.find((t) => t.tenantId === TENANT_A);
    expect(a!.tenantName).toBe('Tenant A');
    expect(a!.messages['blocked']).toBe(2);

    // The queue section agrees with pg-boss's own table.
    const [job] = await db()<{ n: string }[]>`
      select count(*)::text as n from pgboss.job where name = 'message.send' and state = 'created'
    `;
    const send = view.queue.find((q) => q.name === 'message.send');
    expect(send?.created ?? 0).toBe(Number(job!.n));
  });
});

describe('events feed', () => {
  it('filters and pages without gaps or duplicates', async () => {
    await withTenant(TENANT_A, async (tx) => {
      for (let i = 0; i < 250; i += 1) {
        await emit(tx, {
          tenantId: TENANT_A,
          type: i % 2 === 0 ? 'message.probe' : 'other.probe',
          subjectType: 'probe',
          subjectId: String(i),
        });
      }
    });
    await withTenant(TENANT_B, (tx) =>
      emit(tx, { tenantId: TENANT_B, type: 'message.probe', subjectType: 'probe', subjectId: 'b' }),
    );

    // Three pages of 100 over this tenant's rows.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 3; pageNo += 1) {
      const url: string = `/internal/events?tenantId=${TENANT_A}&limit=100${
        cursor ? `&cursor=${cursor}` : ''
      }`;
      const res: { items: { id: string }[]; nextCursor: string | null } = await body(await op(url));
      seen.push(...res.items.map((i: { id: string }) => i.id));
      cursor = res.nextCursor;
    }
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);

    // A prefix filter.
    const prefixed = await body<{ items: { type: string }[] }>(
      await op(`/internal/events?tenantId=${TENANT_A}&type=message.*&limit=500`),
    );
    expect(prefixed.items).toHaveLength(125);
    expect(prefixed.items.every((i) => i.type.startsWith('message.'))).toBe(true);

    // By subject.
    const bySubject = await body<{ items: unknown[] }>(
      await op('/internal/events?subjectType=probe&subjectId=7'),
    );
    expect(bySubject.items).toHaveLength(1);

    // Tenant B's row is not in tenant A's feed.
    const forB = await body<{ items: { tenantId: string }[] }>(
      await op(`/internal/events?tenantId=${TENANT_B}&limit=500`),
    );
    expect(forB.items.every((i) => i.tenantId === TENANT_B)).toBe(true);
  });
});

describe('messages feed', () => {
  it('shows a fallback pair, an ordered timeline and the raw report', async () => {
    const { messageId } = await seed();

    // Give the message a story: sent, then a delivery report.
    await db()`update messages set status = 'sent', provider = 'fake',
               provider_message_id = ${`fake-${messageId}`} where id = ${messageId}`;
    await withTenant(TENANT_A, async (tx) => {
      await emit(tx, {
        tenantId: TENANT_A,
        type: 'message.sent',
        subjectType: 'message',
        subjectId: messageId,
        payload: { provider: 'fake' },
      });
      await emit(tx, {
        tenantId: TENANT_A,
        type: 'message.delivered',
        subjectType: 'message',
        subjectId: messageId,
        payload: { provider: 'fake', raw: { status: 'DELIVERED', vendor: 'body' } },
      });
    });

    // And a fallback child.
    const [child] = await db()<{ id: string }[]>`
      insert into messages (tenant_id, channel, address, purpose, template_name, body,
                            status, contact, variables, fallback_channels, parent_message_id)
      values (${TENANT_A}, 'email', 'a@b.co', 'transactional', 'hello', 'Hi',
              'queued', '{}'::jsonb, '{}'::jsonb, '{}', ${messageId})
      returning id::text as id
    `;

    const feed = await body<{ items: { id: string; timeline: { type: string }[] }[] }>(
      await op(`/internal/messages?tenantId=${TENANT_A}&limit=100`),
    );
    const parent = feed.items.find((m) => m.id === messageId);
    expect(parent!.timeline.map((t) => t.type)).toEqual([
      'message.queued',
      'message.sent',
      'message.delivered',
    ]);
    expect(feed.items.some((m) => m.id === child!.id)).toBe(true);

    const detail = await body<{
      message: { id: string };
      deliveryReports: { payload: { raw: { vendor: string } } }[];
      fallbackChildren: { id: string }[];
    }>(await op(`/internal/messages/${messageId}`));
    expect(detail.message.id).toBe(messageId);
    expect(detail.deliveryReports[0]!.payload.raw.vendor).toBe('body');
    expect(detail.fallbackChildren[0]!.id).toBe(child!.id);
  });
});

describe('jobs and schedules', () => {
  it('shows a failed job with its error and retries it', async () => {
    await seed();

    // Fail a message.send job the way pg-boss would.
    const [job] = await db()<{ id: string }[]>`
      select id::text as id from pgboss.job where name = 'message.send' limit 1
    `;
    await db()`
      update pgboss.job
      set state = 'failed', output = '{"message":"provider exploded"}'::jsonb,
          completed_on = now()
      where name = 'message.send' and id = ${job!.id}
    `;

    const failed = await body<{
      items: { id: string; state: string; output: { message: string }; tenantId: string | null }[];
    }>(await op('/internal/jobs?name=message.send&state=failed'));
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0]!.output.message).toBe('provider exploded');
    // The job's data names a message, so the row says whose it is.
    expect(failed.items[0]!.tenantId).toBe(TENANT_A);

    const retried = await op(`/internal/jobs/${job!.id}/retry`, { method: 'POST' });
    expect(retried.status).toBe(200);

    const [after] = await db()<{ state: string }[]>`
      select state::text as state from pgboss.job where id = ${job!.id}
    `;
    expect(after!.state).not.toBe('failed');

    // A job that is not failed cannot be retried.
    await db()`update pgboss.job set state = 'completed' where id = ${job!.id}`;
    const again = await op(`/internal/jobs/${job!.id}/retry`, { method: 'POST' });
    expect(again.status).toBe(409);
  });

  it('lists the crons with their schedules', async () => {
    const { schedules } = await body<{ schedules: { name: string; cron: string }[] }>(
      await op('/internal/schedules'),
    );
    const names = schedules.map((s) => s.name).sort();
    expect(names).toContain('idempotency.cleanup');
    expect(names).toContain('promo.expire-reservations');
    expect(schedules.find((s) => s.name === 'promo.expire-reservations')!.cron).toBe('*/5 * * * *');
  });
});

describe('metrics', () => {
  it('buckets messages by hour and groups them by status', async () => {
    await seed();

    const result = await body<{
      bucket: string;
      series: { key: string; points: [string, number][] }[];
    }>(await op('/internal/metrics?series=messages&bucket=hour&window=24h&groupBy=status'));

    expect(result.bucket).toBe('hour');
    const total = result.series.flatMap((s) => s.points).reduce((sum, [, n]) => sum + n, 0);
    const [row] = await db()<{ n: string }[]>`select count(*)::text as n from messages`;
    expect(total).toBe(Number(row!.n));

    expect(result.series.map((s) => s.key).sort()).toEqual(
      ['blocked', 'delivered', 'failed', 'queued', 'sent'].sort(),
    );
  });
});

describe('promocodes', () => {
  let keys = 0;
  const paid = (payload: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `promo-key-${(keys += 1)}` },
    body: JSON.stringify(payload),
  });

  async function code(fields: Record<string, unknown>, token = tokenA): Promise<string> {
    const res = await tenant(
      '/v1/promocodes',
      {
        method: 'POST',
        ...json({
          currency: 'SAR',
          discount: { type: 'fixed', value: 5000 },
          funders: [{ party: 'platform', share: 1 }],
          ...fields,
        }),
      },
      token,
    );
    expect(res.status).toBe(201);
    return (await body<{ promocode: { id: string } }>(res)).promocode.id;
  }

  async function redeem(
    codeName: string,
    buyerRef: string,
    orderRef: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await tenant(
      '/v1/redemptions',
      paid({ code: codeName, buyerRef, orderRef, cart: { currency: 'SAR', subtotal: 100000 }, ...extra }),
    );
    expect(res.status).toBe(201);
    return (await body<{ redemption: { id: string } }>(res)).redemption.id;
  }

  type Usage = {
    uses: number;
    spend: number;
    reserved: { count: number; amount: number };
    settled: { count: number; amount: number };
    released: { count: number; amount: number };
    buyers: number;
    remainingUses: number | null;
    remainingSpend: number | null;
    lastRedeemedAt: string | null;
  };
  type Row = { id: string; code: string; tenantName: string; availability: string; usage: Usage };

  const list = async (query = '') =>
    body<{ items: Row[]; nextCursor: string | null }>(await op(`/internal/promocodes${query}`));

  it('shows each code with what its budget has spent', async () => {
    const id = await code({ code: 'SPRING', budget: { maxUses: 3, maxSpend: 20000 } });
    const settled = await redeem('SPRING', 'buyer-1', 'order-1', { buyerCompanyRef: 'co-1' });
    const released = await redeem('SPRING', 'buyer-2', 'order-2');
    await redeem('SPRING', 'buyer-2', 'order-3');
    expect((await tenant(`/v1/redemptions/${settled}/settle`, paid({}))).status).toBe(200);
    expect((await tenant(`/v1/redemptions/${released}/release`, paid({ reason: 'cancelled' }))).status).toBe(200);

    const { items } = await list(`?tenantId=${TENANT_A}`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id,
      code: 'SPRING',
      tenantName: 'Tenant A',
      availability: 'live',
      budget: { maxUses: 3, maxSpend: 20000 },
      funders: [{ party: 'platform', share: 1 }],
    });
    expect(items[0]!.usage).toEqual({
      uses: 2,
      spend: 10000,
      reserved: { count: 1, amount: 5000 },
      settled: { count: 1, amount: 5000 },
      released: { count: 1, amount: 5000 },
      buyers: 2,
      remainingUses: 1,
      remainingSpend: 10000,
      lastRedeemedAt: expect.any(String),
    });

    const detail = await op(`/internal/promocodes/${id}`);
    expect(detail.status).toBe(200);
    expect((await body<{ promocode: Row }>(detail)).promocode).toEqual(items[0]);

    // A redemption links back to its code.
    const feed = await body<{
      items: { promocodeId: string; orderRef: string; buyerCompanyRef: string | null }[];
    }>(await op(`/internal/redemptions?promocodeId=${id}`));
    expect(feed.items).toHaveLength(3);
    expect(feed.items.every((r) => r.promocodeId === id)).toBe(true);
    // And says which of the client's companies it was, when the client said.
    const byOrder = Object.fromEntries(feed.items.map((r) => [r.orderRef, r.buyerCompanyRef]));
    expect(byOrder).toEqual({ 'order-1': 'co-1', 'order-2': null, 'order-3': null });
  });

  it('says why a code cannot be redeemed', async () => {
    const day = 24 * 60 * 60 * 1000;
    await code({ code: 'OPEN' });
    const paused = await code({ code: 'PAUSED' });
    await tenant(`/v1/promocodes/${paused}`, { method: 'PATCH', ...json({ status: 'paused' }) });
    await code({ code: 'OLD', startsAt: new Date(Date.now() - 2 * day), endsAt: new Date(Date.now() - day) });
    await code({ code: 'SOON', startsAt: new Date(Date.now() + day) });
    await code({ code: 'ONCE', budget: { maxUses: 1 } });
    await redeem('ONCE', 'buyer-1', 'order-once');

    const { items } = await list();
    const by = Object.fromEntries(items.map((r) => [r.code, r]));
    expect(by['OPEN']!.availability).toBe('live');
    expect(by['PAUSED']!.availability).toBe('paused');
    expect(by['OLD']!.availability).toBe('expired');
    expect(by['SOON']!.availability).toBe('scheduled');
    expect(by['ONCE']!.availability).toBe('exhausted');
    expect(by['ONCE']!.usage.remainingUses).toBe(0);
    expect(by['OPEN']!.usage).toMatchObject({ uses: 0, remainingUses: null, remainingSpend: null, lastRedeemedAt: null });
  });

  it('filters, pages and spans tenants', async () => {
    for (const name of ['ALPHA1', 'ALPHA2', 'ALPHA3', 'BETA']) await code({ code: name });
    const paused = await code({ code: 'ALPHA4' });
    await tenant(`/v1/promocodes/${paused}`, { method: 'PATCH', ...json({ status: 'paused' }) });
    await code({ code: 'ALPHAB' }, await tokenFor(TENANT_B));

    expect((await list('?code=alpha')).items).toHaveLength(5);
    expect((await list(`?code=alpha&tenantId=${TENANT_A}`)).items).toHaveLength(4);
    expect((await list('?status=paused')).items.map((r) => r.code)).toEqual(['ALPHA4']);
    // LIKE wildcards in the filter are matched literally.
    expect((await list('?code=%25')).items).toHaveLength(0);

    const first = await list('?limit=4');
    expect(first.items).toHaveLength(4);
    expect(first.items[0]!.code).toBe('ALPHAB');
    expect(first.items[0]!.tenantName).toBe('Tenant B');
    const second = await list(`?limit=4&cursor=${first.nextCursor}`);
    const seen = [...first.items, ...second.items].map((r) => r.code);
    expect(new Set(seen).size).toBe(6);
    expect(second.nextCursor).toBeNull();
  });

  it('404s an unknown code and refuses a tenant JWT', async () => {
    expect((await op('/internal/promocodes/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await op('/internal/promocodes/not-a-uuid')).status).toBe(404);
    const res = await app.fetch(
      new Request('http://engine.test/internal/promocodes', {
        headers: { Authorization: `Bearer ${tokenA}` },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('the live stream', () => {
  /** Read SSE frames off the response body for a moment, then stop. */
  async function listen(
    path: string,
    during: () => Promise<void>,
    headers: Record<string, string> = {},
  ): Promise<string> {
    const res = await op(path, { headers });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';

    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += decoder.decode(value, { stream: true });
        }
      } catch {
        // cancelled below
      }
    })();

    await during();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await reader.cancel().catch(() => {});
    await pump;
    return text;
  }

  it('delivers a committed event and never a rolled-back one', async () => {
    const text = await listen('/internal/stream', async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));

      await withTenant(TENANT_A, (tx) =>
        emit(tx, { tenantId: TENANT_A, type: 'stream.committed', subjectType: 'x', subjectId: '1' }),
      );

      await withTenant(TENANT_A, async (tx) => {
        await emit(tx, { tenantId: TENANT_A, type: 'stream.rolledback' });
        throw new Error('deliberate rollback');
      }).catch(() => {});
    });

    expect(text).toContain('event: stream.committed');
    expect(text).not.toContain('stream.rolledback');
    expect(text).toMatch(/id: \d+/);
  });

  it('replays what a reconnecting client missed, in order', async () => {
    const before = await withTenant(TENANT_A, async (tx) => {
      const row = await emit(tx, { tenantId: TENANT_A, type: 'stream.before' });
      return String(row.id);
    });

    await withTenant(TENANT_A, async (tx) => {
      await emit(tx, { tenantId: TENANT_A, type: 'stream.missed.one' });
      await emit(tx, { tenantId: TENANT_A, type: 'stream.missed.two' });
    });

    const text = await listen(
      '/internal/stream',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await withTenant(TENANT_A, (tx) => emit(tx, { tenantId: TENANT_A, type: 'stream.live' }));
      },
      { 'Last-Event-ID': before },
    );

    expect(text.indexOf('stream.missed.one')).toBeGreaterThan(-1);
    expect(text.indexOf('stream.missed.two')).toBeGreaterThan(
      text.indexOf('stream.missed.one'),
    );
    expect(text.indexOf('stream.live')).toBeGreaterThan(text.indexOf('stream.missed.two'));
    expect(text).not.toContain('stream.before');
  });

  it('applies the tenant filter', async () => {
    const text = await listen(`/internal/stream?tenantId=${TENANT_A}`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await withTenant(TENANT_B, (tx) => emit(tx, { tenantId: TENANT_B, type: 'stream.forB' }));
      await withTenant(TENANT_A, (tx) => emit(tx, { tenantId: TENANT_A, type: 'stream.forA' }));
    });

    expect(text).toContain('stream.forA');
    expect(text).not.toContain('stream.forB');
  });

  it(`refuses the ${MAX_CLIENTS + 1}th client`, async () => {
    const readers: { cancel: () => Promise<void> }[] = [];
    try {
      for (let i = 0; i < MAX_CLIENTS; i += 1) {
        const res = await op('/internal/stream');
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        void reader.read();
        readers.push({ cancel: () => reader.cancel().catch(() => {}) });
      }
      // Give the last one a moment to register as a watcher.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const tooMany = await op('/internal/stream');
      expect(tooMany.status).toBe(503);
      expect(await body<{ error: string }>(tooMany)).toMatchObject({ error: 'too_many_streams' });
    } finally {
      for (const reader of readers) await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });
});

describe('secrets', () => {
  it('never returns a channel credential or a webhook secret', async () => {
    const { messageId, deliveryId } = await seed();

    const paths = [
      '/internal/overview',
      '/internal/tenants',
      `/internal/tenants/${TENANT_A}`,
      '/internal/events',
      '/internal/messages',
      `/internal/messages/${messageId}`,
      '/internal/redemptions',
      '/internal/invites',
      '/internal/companies',
      '/internal/webhook-deliveries',
      '/internal/jobs',
      '/internal/schedules',
      '/internal/metrics?series=messages',
    ];

    for (const path of paths) {
      const res = await op(path);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      expect(text, `${path} leaked the channel credential`).not.toContain(CHANNEL_SECRET);
      expect(text, `${path} leaked the webhook secret`).not.toContain(webhookSecret);
      expect(text, `${path} leaked ciphertext`).not.toContain('config_ciphertext');
    }

    expect(deliveryId).toBeTruthy();
  });
});
