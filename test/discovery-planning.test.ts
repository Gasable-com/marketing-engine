import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { resetEnv } from '../src/env.js';
import {
  TASK_RETRY_LIMIT,
  runPlan,
  runTask,
  setProfile,
  type PlanJob,
  type TaskJob,
} from '../src/modules/discovery/index.js';
import { setCompanyLookup, upsert } from '../src/spine/registry/index.js';
import { terms } from './fake-bridge.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb } from './helpers.js';

const app = createApp();
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN!;
const RUNNER_TOKEN = 'test-runner-token-0123456789abcdef0123456789';
const ROW = 'ID\tProduct Name\tCategory\n77\tMicrosilica MS900D  1 MT\tAccelerators';

const IDENTIFIED = {
  name: 'Microsilica (silica fume)',
  nameAr: 'مايكروسيليكا',
  brand: null,
  model: 'MS900D',
  category: 'Concrete admixtures',
  aliases: ['microsilica', 'silica fume', 'مايكروسيليكا'],
  description: 'A fine pozzolan added to concrete for strength.',
  uses: ['high-strength concrete'],
  notIdentified: false,
};

const PERSONAS = {
  personas: [
    {
      name: 'Ready-mix concrete plants',
      description: 'They add it to high-strength mixes.',
      roles: ['manufacturer'],
      sectors: ['construction'],
      searchTerms: terms('ready mix concrete company', 'ready mix concrete Riyadh', 'مصنع خرسانة جاهزة'),
      placesTerms: terms('ready mix concrete', 'خرسانة جاهزة في الرياض'),
      signals: ['mentions high-strength concrete'],
    },
    {
      name: 'Precast concrete factories',
      description: 'Dense precast elements use it.',
      roles: ['manufacturer'],
      sectors: ['construction'],
      searchTerms: terms('precast concrete factory'),
      placesTerms: terms('precast concrete'),
      signals: ['makes precast elements'],
    },
  ],
};

type Call = { task: string; auth: string | undefined; body: Record<string, unknown> };
type Answer = { status: number; body: unknown };

/** The bridge, as far as the engine can tell: one HTTP route. */
let server: Server;
let calls: Call[] = [];
let answer: (task: string, n: number) => Answer = () => ({ status: 500, body: {} });

function defaultAnswer(task: string): Answer {
  if (task === 'identify') return { status: 200, body: { output: IDENTIFIED, durationMs: 5, costUsd: 0 } };
  if (task === 'personas') return { status: 200, body: { output: PERSONAS, durationMs: 5, costUsd: 0 } };
  return { status: 400, body: { error: 'unknown task' } };
}

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://engine.test${path}`, {
      method,
      headers: { 'X-Internal-Token': INTERNAL_TOKEN, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

type Queued = { id: string; name: string; data: PlanJob & TaskJob; start_after: Date; singleton_key: string; expire_in: string };

async function queued(name?: string): Promise<Queued[]> {
  return db()<Queued[]>`
    select id::text, name, data, start_after, singleton_key, expire_in::text from pgboss.job
    where state = 'created' and ${name ? db()`name = ${name}` : db()`name like 'discovery.%'`}
    order by created_on, id
  `;
}

/** Take every waiting discovery job, oldest first, and run it, ignoring start_after. */
async function drive(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const [job] = await queued();
    if (!job) return;
    await db()`delete from pgboss.job where id = ${job.id}`;
    if (job.name === 'discovery.plan') await runPlan(job.data, { finalAttempt: true });
    else await runTask(job.data, { finalAttempt: true });
  }
  throw new Error('drive did not settle');
}

async function createJob(body: Record<string, unknown>) {
  return call<{
    job: Record<string, unknown> & { id: string; status: string };
    personas: Record<string, unknown>[];
    tasks: Record<string, unknown>[];
  }>('POST', '/internal/discovery/jobs', { tenantId: TENANT_A, countries: ['SA'], ...body });
}

async function jobRow(id: string) {
  const [row] = await db()<Record<string, unknown>[]>`select * from discovery_jobs where id = ${id}`;
  return row!;
}

function useBridge(url: string) {
  process.env.CLAUDE_RUNNER_URL = url;
  process.env.CLAUDE_RUNNER_TOKEN = RUNNER_TOKEN;
  resetEnv();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const task = String(body['task']);
      calls.push({ task, auth: req.headers.authorization, body });
      const reply = answer(task, calls.filter((c) => c.task === task).length);
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await resetDb();
  await startQueue();
});

afterAll(async () => {
  delete process.env.CLAUDE_RUNNER_URL;
  delete process.env.CLAUDE_RUNNER_TOKEN;
  resetEnv();
  setCompanyLookup(undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  setCompanyLookup(null);
  calls = [];
  answer = defaultAnswer;
  useBridge(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

describe('planning', () => {
  it('identifies the product and its buyer personas, then queues one task per country', async () => {
    // A seller of the product, already in the pool: never a buyer of it.
    const { company: seller } = await withTenant(TENANT_A, (tx) =>
      upsert(tx, { name: 'Silica Sellers', country: 'SA', identifiers: [], source: { type: 'api', tenantId: TENANT_A } }),
    );
    await withTenant(TENANT_A, (tx) =>
      setProfile(tx, { tenantId: TENANT_A, companyId: seller.id, products: ['Microsilica', 'Silica fume'] }),
    );

    const created = await createJob({ product: 'Microsilica MS900D  1 MT', side: 'buyers', row: ROW });
    expect(created.status).toBe(201);
    expect(created.body.job).toMatchObject({ status: 'planning', side: 'buyers', sourceRow: ROW, live: true });
    expect(created.body.tasks).toEqual([]);

    const [plan] = await queued('discovery.plan');
    expect(plan).toMatchObject({ singleton_key: created.body.job.id, expire_in: '02:00:00' });

    await drive();

    const detail = await call<{
      job: Record<string, unknown>;
      personas: { name: string; searchTerms: string[]; placesTerms: string[] }[];
      tasks: { country: string; status: string; counts: Record<string, number> }[];
    }>('GET', `/internal/discovery/jobs/${created.body.job.id}`);

    expect(detail.body.job).toMatchObject({
      status: 'done',
      live: false,
      waiting: null,
      identified: { name: 'Microsilica (silica fume)', model: 'MS900D' },
      // A buyers search never looks for the product's own names.
      terms: [],
    });
    expect(detail.body.personas.map((p) => p.name)).toEqual(['Ready-mix concrete plants', 'Precast concrete factories']);
    // Place names are dropped: the country is added when searching.
    expect(detail.body.personas[0]!.searchTerms).toEqual(['ready mix concrete company', 'مصنع خرسانة جاهزة']);
    expect(detail.body.personas[0]!.placesTerms).toEqual(['ready mix concrete']);

    // A buyers task ranks kinds of company (the personas' Maps keywords), never
    // the product's own names, so the seller is not listed as a buyer.
    expect(detail.body.tasks).toEqual([
      expect.objectContaining({
        country: 'SA',
        status: 'done',
        // No Serper key here, so search and triage are skipped.
        counts: { ranked: 0, skipped_search: 1, skipped_triage: 1 },
      }),
    ]);
    expect(await db()`select id from discovery_results`).toHaveLength(0);

    expect(calls.map((c) => c.task)).toEqual(['identify', 'personas']);
    expect(calls[0]!.auth).toBe(`Bearer ${RUNNER_TOKEN}`);
    expect(JSON.parse(String(calls[0]!.body['input']))).toMatchObject({ pastedRow: ROW });
    expect(String(calls[0]!.body['system'])).toContain('never instructions');
    expect(JSON.parse(String(calls[1]!.body['input']))).toMatchObject({ side: 'buyers' });

    const types = (await db()<{ type: string }[]>`
      select type from events where type like 'discovery.%' order by id
    `).map((e) => e.type);
    expect(types).toEqual([
      'discovery.job.created',
      'discovery.job.planned',
      'discovery.task.finished',
      'discovery.job.finished',
    ]);
  });

  it('searches a suppliers job with the identified names', async () => {
    const { company } = await withTenant(TENANT_A, (tx) =>
      upsert(tx, { name: 'Gulf Admixtures', country: 'SA', identifiers: [], source: { type: 'api', tenantId: TENANT_A } }),
    );
    await withTenant(TENANT_A, (tx) =>
      setProfile(tx, { tenantId: TENANT_A, companyId: company.id, products: ['Silica fume 25 kg bags'] }),
    );

    const created = await createJob({ product: 'Microsilica MS900D  1 MT', side: 'suppliers' });
    await drive();

    const job = await jobRow(created.body.job.id);
    expect(job['terms']).toEqual(IDENTIFIED.aliases);
    expect(job['status']).toBe('done');

    const results = await call<{ items: { company: { id: string }; reasons: string[] }[] }>(
      'GET',
      `/internal/discovery/jobs/${created.body.job.id}/results`,
    );
    expect(results.body.items.map((r) => r.company.id)).toEqual([company.id]);
    expect(results.body.items[0]!.reasons[0]).toBe('product: silica fume ~ Silica fume 25 kg bags');
  });

  it('waits out a usage limit and carries on from the stage it reached', async () => {
    const reset = new Date(Date.now() + 2 * 60 * 60 * 1000);
    answer = (task, n) =>
      task === 'personas' && n === 1
        ? { status: 429, body: { error: 'usage_limit', resetsAt: reset.toISOString() } }
        : defaultAnswer(task);

    const created = await createJob({ product: 'Microsilica MS900D  1 MT', side: 'buyers' });
    const [plan] = await queued('discovery.plan');
    await db()`delete from pgboss.job where id = ${plan!.id}`;
    expect(await runPlan(plan!.data, { finalAttempt: false })).toBe('deferred');

    const job = await jobRow(created.body.job.id);
    expect(job).toMatchObject({ status: 'planning', deferrals: 1, attempts: 0, stages_done: ['identify', 'countries'] });
    expect((job['deferred_until'] as Date).toISOString()).toBe(reset.toISOString());

    const waitingFor = await queued('discovery.plan');
    expect(waitingFor).toHaveLength(1);
    expect(Math.abs(waitingFor[0]!.start_after.getTime() - reset.getTime())).toBeLessThan(5000);

    const detail = await call<{ job: { waiting: unknown; live: boolean } }>('GET', `/internal/discovery/jobs/${created.body.job.id}`);
    expect(detail.body.job).toMatchObject({ waiting: { reason: 'usage_limit', until: reset.toISOString() }, live: true });

    await drive();
    expect((await jobRow(created.body.job.id))['status']).toBe('done');
    // Identification was not asked for twice.
    expect(calls.map((c) => c.task)).toEqual(['identify', 'personas', 'personas']);

    const deferred = await db()`select payload from events where type = 'discovery.job.deferred'`;
    expect(deferred[0]!['payload']).toMatchObject({ resetsAt: reset.toISOString() });
  });

  it('gives up after too many usage limits', async () => {
    answer = () => ({ status: 429, body: { error: 'usage_limit', resetsAt: null } });
    const created = await createJob({ product: 'Microsilica', side: 'buyers' });

    for (let i = 0; i < 10; i += 1) {
      const [plan] = await queued('discovery.plan');
      if (!plan) break;
      await db()`delete from pgboss.job where id = ${plan.id}`;
      await runPlan(plan.data);
    }
    expect(await jobRow(created.body.job.id)).toMatchObject({
      status: 'failed',
      error: 'usage limit not cleared',
      deferrals: 5,
    });
  });

  it('fails a job whose product cannot be identified, with no tasks', async () => {
    answer = (task) =>
      task === 'identify'
        ? { status: 200, body: { output: { ...IDENTIFIED, notIdentified: true }, durationMs: 1, costUsd: 0 } }
        : defaultAnswer(task);
    const created = await createJob({ product: 'zzz qqq', side: 'suppliers' });
    await drive();

    expect(await jobRow(created.body.job.id)).toMatchObject({
      status: 'failed',
      error: 'the product could not be identified',
    });
    expect(await db()`select id from discovery_tasks`).toHaveLength(0);
    const [finished] = await db()`select payload from events where type = 'discovery.job.finished'`;
    expect(finished!['payload']).toMatchObject({ status: 'failed', error: 'the product could not be identified' });
  });

  it('fails at once when the bridge refuses the request', async () => {
    answer = () => ({ status: 401, body: { error: 'unauthorized' } });
    const created = await createJob({ product: 'Microsilica', side: 'buyers' });
    const [plan] = await queued('discovery.plan');
    await db()`delete from pgboss.job where id = ${plan!.id}`;

    expect(await runPlan(plan!.data, { finalAttempt: false })).toBe('failed');
    expect(await jobRow(created.body.job.id)).toMatchObject({ status: 'failed', error: 'claude bridge: refused (401)' });
    expect(calls).toHaveLength(1);
  });

  it('retries an unreachable bridge, and fails the job on the last attempt', async () => {
    useBridge('http://127.0.0.1:1');
    const created = await createJob({ product: 'Microsilica', side: 'buyers' });
    const [plan] = await queued('discovery.plan');
    await db()`delete from pgboss.job where id = ${plan!.id}`;

    for (let attempt = 0; attempt < TASK_RETRY_LIMIT; attempt += 1) {
      await expect(runPlan(plan!.data, { finalAttempt: false })).rejects.toThrow('claude bridge: unreachable');
      // Let go between attempts, so the retry can claim it again.
      expect(await jobRow(created.body.job.id)).toMatchObject({ status: 'planning', started_at: null });
    }
    await expect(runPlan(plan!.data, { finalAttempt: true })).rejects.toThrow('claude bridge: unreachable');
    expect(await jobRow(created.body.job.id)).toMatchObject({
      status: 'failed',
      error: 'claude bridge: unreachable',
      attempts: TASK_RETRY_LIMIT + 1,
    });
  });

  it('leaves a task alone while another delivery is running it', async () => {
    const created = await createJob({ product: 'Microsilica', side: 'suppliers' });
    const [plan] = await queued('discovery.plan');
    await db()`delete from pgboss.job where id = ${plan!.id}`;
    await runPlan(plan!.data);

    const [task] = await queued('discovery.task');
    await db()`update discovery_tasks set status = 'running', started_at = now() where id = ${task!.data.taskId}`;
    expect(await runTask(task!.data)).toBe('skipped');

    // One whose delivery died long ago is taken over.
    await db()`update discovery_tasks set started_at = now() - interval '3 hours' where id = ${task!.data.taskId}`;
    expect(await runTask(task!.data)).toBe('done');
    expect((await jobRow(created.body.job.id))['status']).toBe('done');
  });

  it('keeps one tenant’s personas from another', async () => {
    const created = await createJob({ product: 'Microsilica', side: 'buyers' });
    await drive();
    const count = (tenantId: string) =>
      withTenant(tenantId, (tx) => tx`select id from discovery_personas where job_id = ${created.body.job.id}`);
    expect(await count(TENANT_A)).toHaveLength(2);
    expect(await count(TENANT_B)).toHaveLength(0);
  });
});

describe('identifying before searching', () => {
  const UNSURE = {
    ...IDENTIFIED,
    name: 'Fondu Cement (High Alumina Cement)',
    brand: null,
    model: null,
    aliases: ['ciment fondu', 'high alumina cement'],
    confidence: 'unsure',
    alternatives: [
      { name: 'Fondu Cement (High Alumina Cement)', nameAr: 'أسمنت فوندو', description: 'Calcium aluminate cement.' },
      { name: 'Fundo-brand Portland Cement', nameAr: 'أسمنت بورتلاند', description: 'Ordinary cement under an unknown brand.' },
    ],
  };
  const SURE = { ...IDENTIFIED, confidence: 'certain', alternatives: [] };

  it('says what the product is, and asks "did you mean" only when Claude is unsure; nothing is stored', async () => {
    answer = () => ({ status: 200, body: { output: UNSURE, durationMs: 1, costUsd: 0 } });
    const unsure = await call<Record<string, unknown>>('POST', '/internal/discovery/identify', { product: 'Fundo Cement' });
    expect(unsure.status).toBe(200);
    expect(unsure.body).toMatchObject({
      identified: { name: 'Fondu Cement (High Alumina Cement)', confidence: 'unsure' },
      didYouMean: {
        asked: 'Fundo Cement',
        best: { name: 'Fondu Cement (High Alumina Cement)' },
        // The best reading is not offered twice.
        alternatives: [{ name: 'Fundo-brand Portland Cement' }],
      },
    });

    answer = () => ({ status: 200, body: { output: SURE, durationMs: 1, costUsd: 0 } });
    const sure = await call<Record<string, unknown>>('POST', '/internal/discovery/identify', { product: 'Microsilica MS900D  1 MT', row: ROW });
    expect(sure.body).toMatchObject({ identified: { name: IDENTIFIED.name }, didYouMean: null });
    expect(JSON.parse(String(calls.at(-1)!.body['input']))).toMatchObject({ pastedRow: ROW });

    // A "best" reading that is only the words as typed is not offered: "as typed" covers it.
    answer = () => ({ status: 200, body: { output: { ...UNSURE, name: 'Fundo Cement' }, durationMs: 1, costUsd: 0 } });
    const echo = await call<Record<string, unknown>>('POST', '/internal/discovery/identify', { product: 'Fundo cement' });
    expect(echo.body).toMatchObject({
      didYouMean: {
        best: null,
        alternatives: [{ name: 'Fondu Cement (High Alumina Cement)' }, { name: 'Fundo-brand Portland Cement' }],
      },
    });

    expect((await call('POST', '/internal/discovery/identify', { product: 'x' })).status).toBe(400);
    expect(await db()`select id from discovery_jobs`).toHaveLength(0);
  });

  it('starts a search from the accepted identification without asking again', async () => {
    const created = await call<{ job: Record<string, unknown> }>('POST', '/internal/discovery/jobs', {
      tenantId: TENANT_A,
      countries: ['SA'],
      product: 'Fundo Cement',
      side: 'suppliers',
      identified: UNSURE,
    });
    expect(created.status).toBe(201);
    expect(created.body.job).toMatchObject({ productConfirmed: true, identified: { name: UNSURE.name }, terms: UNSURE.aliases });
    await drive();
    expect(calls.map((c) => c.task)).toEqual(['personas']);
    expect((await jobRow(String(created.body.job['id'])))['status']).toBe('done');
  });

  it('searches a picked "did you mean" as confirmed, and never stops for an unsure answer', async () => {
    answer = (task) => (task === 'identify' ? { status: 200, body: { output: UNSURE, durationMs: 1, costUsd: 0 } } : defaultAnswer(task));
    const picked = await createJob({ product: 'Fundo-brand Portland Cement', side: 'suppliers', confirmed: true });
    await drive();
    expect(JSON.parse(String(calls[0]!.body['input']))).toMatchObject({ product: 'Fundo-brand Portland Cement', confirmed: true });
    expect(await jobRow(picked.body.job.id)).toMatchObject({ status: 'done', product_confirmed: true });

    // Created without the "did you mean" step at all: still never waits.
    calls = [];
    const direct = await createJob({ product: 'Fundo Cement', side: 'suppliers' });
    await drive();
    expect(calls.map((c) => c.task)).toEqual(['identify', 'personas']);
    expect((await jobRow(direct.body.job.id))['status']).toBe('done');
  });
});

describe('without the bridge', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_RUNNER_URL;
    delete process.env.CLAUDE_RUNNER_TOKEN;
    resetEnv();
  });

  it('refuses a buyers search, and runs a suppliers search as before', async () => {
    const buyers = await createJob({ product: 'Microsilica', side: 'buyers' });
    expect(buyers.status).toBe(400);
    expect(buyers.body).toMatchObject({ error: 'buyers_need_planning' });

    const suppliers = await createJob({ product: 'Microsilica' });
    expect(suppliers.status).toBe(201);
    expect(suppliers.body.job).toMatchObject({ status: 'running', side: 'suppliers' });
    expect(suppliers.body.tasks).toHaveLength(1);
    expect(await queued('discovery.plan')).toHaveLength(0);
    expect(calls).toHaveLength(0);

    const identify = await call('POST', '/internal/discovery/identify', { product: 'Microsilica' });
    expect(identify).toMatchObject({ status: 200, body: { identified: null, didYouMean: null } });
  });
});
