/**
 * Brief 13: unschedule a campaign that has not started, edit one between runs,
 * and duplicate any campaign. Jobs are driven by hand.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db } from '../src/db/client.js';
import { resetFake } from '../src/modules/messaging/adapters/fake.js';
import { processBatch, runCampaign, type BatchJob, type RunJob } from '../src/modules/campaigns/index.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();

// US numbers: no sending-window rule applies, so batches send at any clock.
const us = (i: number) => `+1415555${String(200 + i).padStart(4, '0')}`;
const HOUR = 3_600_000;

let tokenA: string;
let tokenB: string;

async function call<T = Record<string, any>>(method: string, path: string, body?: unknown, token = tokenA) {
  const res = await app.fetch(
    new Request(`http://engine.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function setup() {
  await call('PUT', '/v1/channels/sms', {
    provider: 'fake', sender: 'ACME', unsubscribeText: 'Reply STOP', config: { token: 'good' },
  });
  await call('PUT', '/v1/templates/promo', { channel: 'sms', body: 'Hi {{ contact.name }}' });
  await call('PUT', '/v1/templates/promo-v2', { channel: 'sms', body: 'Hello again {{ contact.name }}' });
}

async function seedContacts(phones: string[]): Promise<string[]> {
  const rows = await db()<{ id: string }[]>`
    insert into contacts (tenant_id, phone, name)
    select ${TENANT_A}, p, p from unnest(${phones}::text[]) as p
    returning id
  `;
  await db()`
    insert into consent (tenant_id, channel, address, purpose, status, source)
    select ${TENANT_A}, 'sms', p, 'marketing', 'granted', 'test' from unnest(${phones}::text[]) as p
  `;
  return rows.map((r) => r.id);
}

/** A draft over a static audience of `n` consented contacts. */
async function draft(n: number, extra: Record<string, unknown> = {}): Promise<string> {
  const ids = await seedContacts(Array.from({ length: n }, (_, i) => us(i)));
  const audience = await call<{ audience: { id: string } }>('POST', '/v1/audiences', {
    name: `a-${Math.random()}`, kind: 'static',
  });
  await call('POST', `/v1/audiences/${audience.body.audience.id}/members`, { contactIds: ids });
  const created = await call<{ campaign: { id: string } }>('POST', '/v1/campaigns', {
    name: 'Spring promo',
    audienceId: audience.body.audience.id,
    template: 'promo',
    channel: 'sms',
    purpose: 'marketing',
    ...extra,
  });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  return created.body.campaign.id;
}

async function scheduled(n: number, extra: Record<string, unknown> = {}): Promise<string> {
  const id = await draft(n, extra);
  const res = await call('POST', `/v1/campaigns/${id}/schedule`);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return id;
}

type Job = { id: string; data: RunJob & BatchJob; start_after: Date };

async function waiting(name: string): Promise<Job[]> {
  return db()<Job[]>`
    select id::text, data, start_after from pgboss.job
    where name = ${name} and state = 'created' order by created_on, id
  `;
}

/** Run the campaign.run job for `runNo` through to its last batch. */
async function runToEnd(runNo: number): Promise<void> {
  const job = (await waiting('campaign.run')).find((j) => j.data.runNo === runNo);
  if (!job) throw new Error(`no waiting job for run ${runNo}`);
  await db()`delete from pgboss.job where id = ${job.id}`;
  await runCampaign(job.data);
  const [batch] = await waiting('campaign.batch');
  await db()`delete from pgboss.job where name = 'campaign.batch'`;
  for (let i = 0; i < 100; i += 1) {
    const out = await processBatch(batch!.data);
    await db()`delete from pgboss.job where name = 'campaign.batch'`;
    if (out.state !== 'sent') break;
  }
}

async function get(id: string, token = tokenA) {
  return call<{ campaign: Record<string, any> }>('GET', `/v1/campaigns/${id}`, undefined, token);
}

async function events(type: string, id: string) {
  return db()<{ payload: Record<string, any> }[]>`
    select payload from events where type = ${type} and subject_id = ${id} order by occurred_at, id
  `;
}

beforeAll(async () => {
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  await db()`delete from pgboss.job where name like 'campaign.%'`;
  resetFake();
  await setup();
});

describe('unschedule', () => {
  it('takes a scheduled campaign back to draft, and a reschedule fires at the new time', async () => {
    const id = await scheduled(2, { scheduledAt: new Date(Date.now() + 24 * HOUR).toISOString() });
    expect(await waiting('campaign.run')).toHaveLength(1);

    const res = await call('POST', `/v1/campaigns/${id}/unschedule`);
    expect(res.status).toBe(200);
    expect(res.body.campaign).toMatchObject({ status: 'draft', nextRunAt: null });
    expect(await waiting('campaign.run')).toHaveLength(0);
    expect(await events('campaign.unscheduled', id)).toEqual([{ payload: { from: 'scheduled' } }]);

    const later = new Date(Date.now() + 48 * HOUR);
    expect((await call('PATCH', `/v1/campaigns/${id}`, {
      template: 'promo-v2', scheduledAt: later.toISOString(),
    })).status).toBe(200);
    expect((await call('POST', `/v1/campaigns/${id}/schedule`)).status).toBe(200);

    const jobs = await waiting('campaign.run');
    expect(jobs).toHaveLength(1);
    expect(Math.abs(jobs[0]!.start_after.getTime() - later.getTime())).toBeLessThan(2000);
  });

  it('unschedules a campaign paused before its first run', async () => {
    const id = await scheduled(1, { scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    await call('POST', `/v1/campaigns/${id}/pause`);
    const res = await call('POST', `/v1/campaigns/${id}/unschedule`);
    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe('draft');
    expect(await events('campaign.unscheduled', id)).toEqual([{ payload: { from: 'paused' } }]);
  });

  it('refuses once a run has started, and for a draft', async () => {
    const id = await scheduled(1, { recurrence: { cron: '0 10 * * 1' } });
    await db()`update pgboss.job set start_after = now() where name = 'campaign.run'`;
    await runToEnd(1);
    await call('POST', `/v1/campaigns/${id}/pause`);

    const started = await call('POST', `/v1/campaigns/${id}/unschedule`);
    expect(started.status).toBe(409);
    expect(started.body.error).toBe('already_started');

    const other = await draft(0);
    const res = await call('POST', `/v1/campaigns/${other}/unschedule`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_state');
  });
});

describe('edit between runs', () => {
  it('edits a paused recurring campaign; the next run uses the edit', async () => {
    const id = await scheduled(2, { recurrence: { cron: '0 10 * * 1' } });
    await runToEnd(1);
    expect((await get(id)).body.campaign.status).toBe('scheduled');
    expect(await waiting('campaign.run')).toHaveLength(1);

    await call('POST', `/v1/campaigns/${id}/pause`);
    const res = await call('PATCH', `/v1/campaigns/${id}`, { template: 'promo-v2', throttlePerMinute: 30 });
    expect(res.status).toBe(200);
    expect(res.body.campaign).toMatchObject({ status: 'paused', template: 'promo-v2', throttlePerMinute: 30 });
    expect(res.body.campaign.nextRunAt).not.toBeNull();
    // The run-2 job queued for the old settings is gone.
    expect(await waiting('campaign.run')).toHaveLength(0);

    const [edited] = await events('campaign.edited', id);
    expect(edited!.payload).toEqual({
      status: 'paused',
      appliesFromRun: 2,
      changes: {
        template: { from: 'promo', to: 'promo-v2' },
        throttlePerMinute: { from: 60, to: 30 },
      },
    });

    const resumed = await call('POST', `/v1/campaigns/${id}/resume`);
    expect(resumed.body.campaign.status).toBe('scheduled');
    const jobs = await waiting('campaign.run');
    expect(jobs.map((j) => j.data.runNo)).toEqual([2]);
    // Enqueued in whole seconds, so within one of the recomputed time.
    expect(Math.abs(jobs[0]!.start_after.getTime() - Date.parse(res.body.campaign.nextRunAt))).toBeLessThan(1000);

    await runToEnd(2);
    const sent = await db()<{ template_name: string; run_no: number }[]>`
      select m.template_name, r.run_no from messages m
      join campaign_runs r on r.id = m.campaign_run_id
      order by r.run_no, m.template_name
    `;
    expect(sent).toEqual([
      { template_name: 'promo', run_no: 1 },
      { template_name: 'promo', run_no: 1 },
      { template_name: 'promo-v2', run_no: 2 },
      { template_name: 'promo-v2', run_no: 2 },
    ]);
  });

  it('refuses while a run is sending, and in every non-paused live state', async () => {
    const id = await scheduled(20, { throttlePerMinute: 6 });
    let res = await call('PATCH', `/v1/campaigns/${id}`, { name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_editable');

    const [job] = await waiting('campaign.run');
    await db()`delete from pgboss.job where id = ${job!.id}`;
    await runCampaign(job!.data);
    const [batch] = await waiting('campaign.batch');
    await processBatch(batch!.data);
    expect((await get(id)).body.campaign.status).toBe('running');
    res = await call('PATCH', `/v1/campaigns/${id}`, { name: 'x' });
    expect(res.status).toBe(409);

    await call('POST', `/v1/campaigns/${id}/pause`);
    res = await call('PATCH', `/v1/campaigns/${id}`, { name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_editable');
    expect(res.body.message).toMatch(/run is in progress/);

    await db()`update campaigns set status = 'done' where id = ${id}`;
    res = await call('PATCH', `/v1/campaigns/${id}`, { name: 'x' });
    expect(res.status).toBe(409);
  });

  it('leaves a past scheduledAt alone unless the edit sets one', async () => {
    const id = await scheduled(1, { recurrence: { cron: '0 10 * * 1' } });
    await runToEnd(1);
    await call('POST', `/v1/campaigns/${id}/pause`);
    await db()`update campaigns set scheduled_at = now() - interval '7 days' where id = ${id}`;

    expect((await call('PATCH', `/v1/campaigns/${id}`, { name: 'Renamed' })).status).toBe(200);

    const past = await call('PATCH', `/v1/campaigns/${id}`, {
      scheduledAt: new Date(Date.now() - HOUR).toISOString(),
    });
    expect(past.status).toBe(400);
    expect(past.body.error).toBe('scheduled_at_past');
  });

  it('finishes on resume when the edit leaves no future run', async () => {
    const id = await scheduled(1, { recurrence: { cron: '0 10 * * 1', maxRuns: 3 } });
    await runToEnd(1);
    await call('POST', `/v1/campaigns/${id}/pause`);

    const res = await call('PATCH', `/v1/campaigns/${id}`, { recurrence: { cron: '0 10 * * 1', maxRuns: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.campaign.nextRunAt).toBeNull();

    const resumed = await call('POST', `/v1/campaigns/${id}/resume`);
    expect(resumed.body.campaign.status).toBe('done');
    expect(await waiting('campaign.run')).toHaveLength(0);
  });

  it('emits nothing for an edit that changes nothing', async () => {
    const id = await draft(1);
    expect((await call('PATCH', `/v1/campaigns/${id}`, { name: 'Spring promo' })).status).toBe(200);
    expect(await events('campaign.edited', id)).toHaveLength(0);

    await call('PATCH', `/v1/campaigns/${id}`, { name: 'Summer promo' });
    const [edited] = await events('campaign.edited', id);
    expect(edited!.payload).toEqual({
      status: 'draft', appliesFromRun: 1, changes: { name: { from: 'Spring promo', to: 'Summer promo' } },
    });
  });
});

describe('duplicate', () => {
  it('copies a cancelled campaign into a new draft', async () => {
    const id = await scheduled(1, {
      scheduledAt: new Date(Date.now() + HOUR).toISOString(),
      variables: { code: 'SPRING' },
      throttlePerMinute: 12,
    });
    await call('POST', `/v1/campaigns/${id}/cancel`);
    // Its time has passed since, so the copy starts unscheduled.
    await db()`update campaigns set scheduled_at = now() - interval '1 hour' where id = ${id}`;
    const original = (await get(id)).body.campaign;

    const res = await call('POST', `/v1/campaigns/${id}/duplicate`);
    expect(res.status).toBe(201);
    const copy = res.body.campaign;
    expect(copy.id).not.toBe(id);
    expect(copy).toMatchObject({
      name: 'Spring promo (copy)',
      status: 'draft',
      audienceId: original.audienceId,
      template: 'promo',
      channel: 'sms',
      purpose: 'marketing',
      variables: { code: 'SPRING' },
      throttlePerMinute: 12,
      scheduledAt: null,
    });
    expect((await get(id)).body.campaign).toEqual(original);

    const [created] = await events('campaign.created', copy.id);
    expect(created!.payload.duplicatedFrom).toBe(id);
  });

  it('keeps a future scheduledAt and takes a custom name', async () => {
    const at = new Date(Date.now() + 24 * HOUR).toISOString();
    const id = await draft(1, { scheduledAt: at });
    const res = await call('POST', `/v1/campaigns/${id}/duplicate`, { name: 'Take two' });
    expect(res.status).toBe(201);
    expect(res.body.campaign).toMatchObject({ name: 'Take two', scheduledAt: at });
  });

  it('refuses when the template has gone', async () => {
    const id = await draft(1);
    await db()`delete from templates where name = 'promo'`;
    const res = await call('POST', `/v1/campaigns/${id}/duplicate`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('template_not_found');
  });
});

describe('tenancy', () => {
  it("won't let tenant B unschedule, edit or duplicate A's campaign", async () => {
    const id = await scheduled(1, { scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    expect((await call('POST', `/v1/campaigns/${id}/unschedule`, undefined, tokenB)).status).toBe(404);
    expect((await call('PATCH', `/v1/campaigns/${id}`, { name: 'x' }, tokenB)).status).toBe(404);
    expect((await call('POST', `/v1/campaigns/${id}/duplicate`, undefined, tokenB)).status).toBe(404);
    expect((await get(id)).body.campaign.status).toBe('scheduled');
  });
});
