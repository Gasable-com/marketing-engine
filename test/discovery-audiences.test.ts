/**
 * Brief 26: found buyers as an audience. A supplier's finished searches
 * become a discovery audience of hidden contacts, sent to as outreach: no
 * consent, every opt-out and sending window still in force, and never an
 * address in anything the tenant can read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { processBatch, runCampaign, type BatchJob, type RunJob } from '../src/modules/campaigns/index.js';
import { setProfile } from '../src/modules/discovery/index.js';
import { fakeCalls, resetFake } from '../src/modules/messaging/adapters/fake.js';
import { processSend } from '../src/modules/messaging/worker.js';
import { upsert } from '../src/spine/registry/index.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();

let tokenA: string;
let tokenB: string;

// US numbers see no sending window; the Saudi ones are for the quiet-hour test.
const us = (i: number) => `+1415555${String(i).padStart(4, '0')}`;
const sa = (i: number) => `+9665012345${String(i).padStart(2, '0')}`;
const RIYADH = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2027, 2, day, h! - 3, m!));
};

async function call<T = Record<string, any>>(method: string, path: string, body?: unknown, token = tokenA) {
  const res = await app.fetch(
    new Request(`http://engine.test${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, text };
}

async function setupChannels() {
  await call('PUT', '/v1/channels/sms', {
    provider: 'fake', sender: 'ACME', unsubscribeText: 'Reply STOP', config: { token: 'good' },
  });
  await call('PUT', '/v1/channels/email', {
    provider: 'fake', sender: 'news@acme.test', config: { token: 'good' },
  });
  await call('PUT', '/v1/templates/outreach', { channel: 'sms', body: 'Hello {{ contact.name }}' });
  await call('PUT', '/v1/templates/outreach', {
    channel: 'email', subject: 'Hello {{ contact.name }}', body: 'Hello {{ contact.name }}',
  });
}

/** A company in the pool with what the registry knows of it. */
async function company(
  name: string,
  opts: { phones?: string[]; emails?: string[]; city?: string; country?: string } = {},
): Promise<string> {
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '-');
  const { company: row } = await withTenant(TENANT_A, (tx) =>
    upsert(tx, {
      name,
      country: opts.country ?? 'SA',
      identifiers: [
        { type: 'domain', value: `${slug}.test` },
        ...(opts.phones ?? []).map((value) => ({ type: 'phone', value })),
        ...(opts.emails ?? []).map((value) => ({ type: 'email', value })),
      ],
      source: { type: 'api', tenantId: TENANT_A },
    }),
  );
  await withTenant(TENANT_A, (tx) =>
    setProfile(tx, { tenantId: TENANT_A, companyId: row.id, buys: ['diesel'], cities: [opts.city ?? 'Riyadh'] }),
  );
  return row.id;
}

type Result = { companyId: string; rank: number; fit?: 'strong' | 'weak' | null };

/** A finished (or not) search straight into the tables, with its ranked results. */
async function search(
  requesterRef: string,
  results: Result[],
  opts: { status?: 'running' | 'done'; tenantId?: string } = {},
): Promise<string> {
  const tenantId = opts.tenantId ?? TENANT_A;
  const status = opts.status ?? 'done';
  const [job] = await db()<{ id: string }[]>`
    insert into discovery_jobs (tenant_id, product, side, countries, status, requester_ref, finished_at)
    values (${tenantId}, 'Diesel fuel', 'buyers', ${['SA']}, ${status}, ${requesterRef},
            ${status === 'done' ? new Date() : null})
    returning id
  `;
  const [task] = await db()<{ id: string }[]>`
    insert into discovery_tasks (tenant_id, job_id, country, status)
    values (${tenantId}, ${job!.id}, 'SA', ${status}) returning id
  `;
  for (const r of results) {
    await db()`
      insert into discovery_results (tenant_id, job_id, task_id, company_id, rank, score, reasons, fit, tier)
      values (${tenantId}, ${job!.id}, ${task!.id}, ${r.companyId}, ${r.rank}, ${1 / r.rank}, ${['persona: Buyers']},
              ${r.fit === undefined ? 'strong' : r.fit}, 'found')
    `;
  }
  return job!.id;
}

type Definition = { requesterRef: string; searchIds: string[]; fit?: string[]; excludeCompanyIds?: string[] };

async function audience(definition: Definition, name = `buyers-${Math.random()}`) {
  const res = await call<{ audience: { id: string } }>('POST', '/v1/audiences', { name, kind: 'discovery', definition });
  if (res.status !== 201) throw new Error(`create audience: ${res.status} ${res.text}`);
  return res.body.audience.id;
}

async function campaign(audienceId: string, extra: Record<string, unknown> = {}) {
  const res = await call<{ campaign: { id: string } }>('POST', '/v1/campaigns', {
    name: `c-${Math.random()}`,
    audienceId,
    template: 'outreach',
    channel: null,
    purpose: 'outreach',
    ...extra,
  });
  if (res.status !== 201) throw new Error(`create campaign: ${res.status} ${res.text}`);
  const scheduled = await call('POST', `/v1/campaigns/${res.body.campaign.id}/schedule`);
  if (scheduled.status !== 200) throw new Error(`schedule: ${scheduled.status} ${scheduled.text}`);
  return res.body.campaign.id;
}

type Job = { id: string; name: string; data: RunJob & BatchJob };

async function createdJobs(name?: string): Promise<Job[]> {
  return db()<Job[]>`
    select id::text, name, data from pgboss.job
    where state = 'created' and ${name ? db()`name = ${name}` : db()`name like 'campaign.%'`}
    order by created_on, id
  `;
}

/** Drive the campaign workers by hand: take the oldest waiting job, delete it, run it. */
async function drive() {
  for (let i = 0; i < 200; i += 1) {
    const [job] = await createdJobs();
    if (!job) return;
    await db()`delete from pgboss.job where id = ${job.id}`;
    if (job.name === 'campaign.run') await runCampaign(job.data);
    else await processBatch(job.data);
  }
  throw new Error('drive did not settle');
}

/** Run the waiting campaign.run job; return the batch job for the run it opened. */
async function expand(): Promise<BatchJob> {
  const [job] = await createdJobs('campaign.run');
  await db()`delete from pgboss.job where id = ${job!.id}`;
  await runCampaign(job!.data);
  const [batch] = await createdJobs('campaign.batch');
  await db()`delete from pgboss.job where name = 'campaign.batch'`;
  return batch!.data;
}

type Recipient = {
  contactId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  company: { id: string; name: string } | null;
  state: string;
  reason: string | null;
  messageId: string | null;
};

async function recipientsOf(campaignId: string) {
  const runs = await call<{ items: { id: string }[] }>('GET', `/v1/campaigns/${campaignId}/runs`);
  const run = runs.body.items[0]!;
  const res = await call<{ items: Recipient[] }>('GET', `/v1/campaigns/${campaignId}/runs/${run.id}/recipients`);
  return { run, items: res.body.items, text: res.text };
}

async function hiddenContacts() {
  return db()<{ id: string; phone: string | null; email: string | null; company_id: string; name: string }[]>`
    select id, phone, email, company_id, name from contacts where tenant_id = ${TENANT_A} and hidden order by name
  `;
}

beforeAll(async () => {
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(teardownDb);

beforeEach(async () => {
  await resetDb();
  await db()`delete from pgboss.job where name like 'campaign.%'`;
  resetFake();
  await setupChannels();
});

describe('a discovery audience', () => {
  it('is one contact per buyer: across searches, by fit, minus the unticked, the merged and the on-platform', async () => {
    const alfa = await company('Alfa Diesel', { phones: [us(1)], emails: ['sales@alfa-diesel.test'] });
    const bravo = await company('Bravo Transport', { phones: [us(21), us(22), us(23), us(24), us(25)] });
    const charlie = await company('Charlie Farms');
    const delta = await company('Delta Mining', { phones: [us(4)] });
    await db()`update companies set on_platform_ref = 'mkt-delta', on_platform_at = now() where id = ${delta}`;
    const foxtrot = await company('Foxtrot Logistics', { phones: [us(6)] });
    const echo = await company('Echo Logistics', { phones: [us(5)] });
    await db()`update companies set merged_into = ${foxtrot} where id = ${echo}`;
    const golf = await company('Golf Quarries', { phones: [us(7)] });
    const hotel = await company('Hotel Resorts', { phones: [us(8)] });

    const s1 = await search('sup-1', [
      { companyId: alfa, rank: 1 },
      { companyId: bravo, rank: 2 },
      { companyId: charlie, rank: 3 },
      { companyId: echo, rank: 4 },
      { companyId: golf, rank: 5 },
    ]);
    const s2 = await search('sup-1', [
      { companyId: alfa, rank: 1 },
      { companyId: delta, rank: 2 },
      { companyId: hotel, rank: 3, fit: 'weak' },
      { companyId: bravo, rank: 4 },
    ]);
    const definition = { requesterRef: 'sup-1', searchIds: [s1, s2], excludeCompanyIds: [golf] };

    // The read-only preview while the supplier is picking.
    const preview = await call<{
      companies: number; reachable: number; unreachable: number;
      buyers: { company: { id: string; name: string }; city: string; country: string; fit: string; rank: number; searchIds: string[]; reachable: boolean }[];
    }>('POST', '/v1/audiences/discovery-preview', definition);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ companies: 4, reachable: 3, unreachable: 1 });
    expect(preview.body.buyers.map((b) => [b.company.name, b.rank, b.reachable])).toEqual([
      ['Alfa Diesel', 1, true],
      ['Bravo Transport', 2, true],
      ['Charlie Farms', 3, false],
      // Echo was merged into Foxtrot: ranked where Echo was, named as Foxtrot.
      ['Foxtrot Logistics', 4, true],
    ]);
    expect(preview.body.buyers[0]).toEqual({
      company: { id: alfa, name: 'Alfa Diesel' },
      city: 'Riyadh',
      country: 'SA',
      fit: 'strong',
      rank: 1,
      searchIds: [s1, s2],
      reachable: true,
    });
    for (const leak of ['+1415', 'sales@', '.test']) expect(preview.text).not.toContain(leak);
    expect(await hiddenContacts()).toEqual([]);

    // Saved, it resolves to the same buyers, one contact each.
    const id = await audience(definition, 'Buyers: Diesel fuel + 1 more');
    const got = await call<{ audience: Record<string, unknown> }>('GET', `/v1/audiences/${id}`);
    expect(got.body.audience).toMatchObject({
      kind: 'discovery',
      members: null,
      definition: { requesterRef: 'sup-1', searchIds: [s1, s2], fit: ['strong'], excludeCompanyIds: [golf] },
    });
    const listed = await call<{ items: { id: string; members: number | null }[] }>('GET', '/v1/audiences');
    expect(listed.body.items.find((a) => a.id === id)).toMatchObject({ members: null });

    const saved = await call<{
      total: number; sendable: number; companies: number; reachable: number; unreachable: number;
      contacts: { name: string; phone: null; email: null; telegram: null; company: { id: string; name: string }; allowed: boolean; channel: string }[];
    }>('POST', `/v1/audiences/${id}/preview`);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ total: 3, sampled: 3, sendable: 3, companies: 4, reachable: 3, unreachable: 1 });
    expect(saved.body.contacts.map((c) => c.company.name).sort()).toEqual(['Alfa Diesel', 'Bravo Transport', 'Foxtrot Logistics']);
    for (const contact of saved.body.contacts) {
      expect(contact).toMatchObject({ phone: null, email: null, telegram: null, allowed: true, channel: 'sms' });
    }
    for (const leak of ['+1415', 'sales@', '.test']) expect(saved.text).not.toContain(leak);
    // The preview's counts are the saved audience's counts.
    expect([saved.body.companies, saved.body.reachable, saved.body.unreachable]).toEqual([
      preview.body.companies, preview.body.reachable, preview.body.unreachable,
    ]);

    // Five phones, one contact, holding the longest-known phone and named after the company.
    const hidden = await hiddenContacts();
    expect(hidden.map((c) => [c.name, c.phone, c.email, c.company_id])).toEqual([
      ['Alfa Diesel', us(1), 'sales@alfa-diesel.test', alfa],
      ['Bravo Transport', us(21), null, bravo],
      ['Foxtrot Logistics', us(6), null, foxtrot],
    ]);

    // Resolving again makes nothing new.
    await call('POST', `/v1/audiences/${id}/preview`);
    expect(await hiddenContacts()).toHaveLength(3);

    // Widening the fit admits the possible buyer too.
    const patched = await call('PATCH', `/v1/audiences/${id}`, { definition: { ...definition, fit: ['strong', 'weak'] } });
    expect(patched.status).toBe(200);
    const wider = await call<{ companies: number; total: number }>('POST', `/v1/audiences/${id}/preview`);
    expect(wider.body).toMatchObject({ companies: 5, total: 4 });
    expect((await hiddenContacts()).map((c) => c.name)).toContain('Hotel Resorts');
  });

  it('reuses the tenant\'s own contact for an address it already holds, unchanged', async () => {
    const alfa = await company('Alfa Diesel', { phones: [us(1)], emails: ['sales@alfa-diesel.test'] });
    const own = await call<{ contact: { id: string } }>('POST', '/v1/contacts', { phone: us(1), name: 'Amal at Alfa' });
    const s1 = await search('sup-1', [{ companyId: alfa, rank: 1 }]);
    const id = await audience({ requesterRef: 'sup-1', searchIds: [s1] });

    const preview = await call<{ contacts: { id: string; name: string; phone: string | null; email: string | null }[] }>(
      'POST',
      `/v1/audiences/${id}/preview`,
    );
    expect(preview.body.contacts).toEqual([
      expect.objectContaining({ id: own.body.contact.id, name: 'Amal at Alfa', phone: us(1), email: null }),
    ]);
    expect(await hiddenContacts()).toEqual([]);
  });

  it('refuses another requester\'s search, an unfinished one, another tenant\'s and more than twenty', async () => {
    const alfa = await company('Alfa Diesel', { phones: [us(1)] });
    const mine = await search('sup-1', [{ companyId: alfa, rank: 1 }]);
    const theirs = await search('sup-2', [{ companyId: alfa, rank: 1 }]);
    const running = await search('sup-1', [], { status: 'running' });
    const otherTenant = await search('sup-1', [{ companyId: alfa, rank: 1 }], { tenantId: TENANT_B });

    const create = (searchIds: string[]) =>
      call('POST', '/v1/audiences', { name: `a-${Math.random()}`, kind: 'discovery', definition: { requesterRef: 'sup-1', searchIds } });
    const preview = (searchIds: string[]) =>
      call('POST', '/v1/audiences/discovery-preview', { requesterRef: 'sup-1', searchIds });

    for (const attempt of [create, preview]) {
      const notMine = await attempt([mine, theirs]);
      expect(notMine.status).toBe(400);
      expect(notMine.body).toMatchObject({ error: 'search_not_found', ids: [theirs] });

      const notTheirTenant = await attempt([otherTenant]);
      expect(notTheirTenant.body).toMatchObject({ error: 'search_not_found', ids: [otherTenant] });

      const notDone = await attempt([mine, running]);
      expect(notDone.status).toBe(400);
      expect(notDone.body).toMatchObject({ error: 'search_not_done', ids: [running] });

      const tooMany = await attempt(Array.from({ length: 21 }, () => crypto.randomUUID()));
      expect(tooMany.status).toBe(400);
    }

    // The same checks on an edit.
    const id = await audience({ requesterRef: 'sup-1', searchIds: [mine] });
    const edited = await call('PATCH', `/v1/audiences/${id}`, { definition: { requesterRef: 'sup-1', searchIds: [theirs] } });
    expect(edited.status).toBe(400);
    expect(edited.body).toMatchObject({ error: 'search_not_found', ids: [theirs] });
    const wrongShape = await call('PATCH', `/v1/audiences/${id}`, { definition: { finderQuery: { buys: ['diesel'] } } });
    expect(wrongShape.status).toBe(400);
    expect(wrongShape.body).toMatchObject({ error: 'invalid_definition' });
  });
});

describe('hidden contacts', () => {
  it('are in no list, no static or search audience, and come into the open when the tenant stores the address', async () => {
    const alfa = await company('Alfa Diesel', { phones: [us(1)] });
    const own = await call<{ contact: { id: string } }>('POST', '/v1/contacts', { phone: us(9), name: 'Own' });
    const s1 = await search('sup-1', [{ companyId: alfa, rank: 1 }]);
    const id = await audience({ requesterRef: 'sup-1', searchIds: [s1] });
    await call('POST', `/v1/audiences/${id}/preview`);
    const [hidden] = await hiddenContacts();
    expect(hidden).toBeDefined();

    const listed = await call<{ items: { id: string }[] }>('GET', '/v1/contacts');
    expect(listed.body.items.map((c) => c.id)).toEqual([own.body.contact.id]);
    expect(listed.text).not.toContain(us(1));
    expect((await call('GET', `/v1/contacts/${hidden!.id}`)).status).toBe(404);
    expect((await call('PATCH', `/v1/contacts/${hidden!.id}`, { name: 'x' })).status).toBe(404);

    const fixed = await call<{ audience: { id: string } }>('POST', '/v1/audiences', { name: 'list', kind: 'static' });
    const added = await call('POST', `/v1/audiences/${fixed.body.audience.id}/members`, { contactIds: [hidden!.id, own.body.contact.id] });
    expect(added.body).toEqual({ added: 1, unknown: [hidden!.id] });

    const searched = await call<{ audience: { id: string } }>('POST', '/v1/audiences', {
      name: 'search', kind: 'search', definition: { finderQuery: { buys: ['diesel'] } },
    });
    const before = await call<{ total: number }>('POST', `/v1/audiences/${searched.body.audience.id}/preview`);
    expect(before.body.total).toBe(0);

    // The tenant stores the number itself: the contact is its own now.
    const stored = await call<{ contact: { id: string; phone: string; companyId: string }; created: boolean }>(
      'POST', '/v1/contacts', { phone: us(1), name: 'Amal' },
    );
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({ created: false, contact: { id: hidden!.id, phone: us(1), companyId: alfa } });
    expect((await call<{ items: { id: string }[] }>('GET', '/v1/contacts')).body.items.map((c) => c.id).sort()).toEqual(
      [hidden!.id, own.body.contact.id].sort(),
    );
    expect((await call('GET', `/v1/contacts/${hidden!.id}`)).status).toBe(200);
    expect((await call<{ total: number }>('POST', `/v1/audiences/${searched.body.audience.id}/preview`)).body.total).toBe(1);
    expect(await hiddenContacts()).toEqual([]);
  });

  it('show no address in recipients, the message, the body or the events', async () => {
    const alfa = await company('Alfa Diesel', { phones: [us(1)], emails: ['sales@alfa-diesel.test'] });
    const bravo = await company('Bravo Transport', { emails: ['buy@bravo-transport.test'] });
    const s1 = await search('sup-1', [{ companyId: alfa, rank: 1 }, { companyId: bravo, rank: 2 }]);
    const id = await campaign(await audience({ requesterRef: 'sup-1', searchIds: [s1] }));
    await drive();

    const { run, items, text } = await recipientsOf(id);
    expect(run).toMatchObject({ status: 'done', audienceSize: 2, queued: 2, blocked: 0 });
    expect(items.map((r) => [r.name, r.phone, r.email, r.telegram, r.company?.name, r.state]).sort()).toEqual([
      ['Alfa Diesel', null, null, null, 'Alfa Diesel', 'queued'],
      ['Bravo Transport', null, null, null, 'Bravo Transport', 'queued'],
    ]);
    for (const leak of ['+1415', 'sales@', 'buy@', '.test']) expect(text).not.toContain(leak);

    // Best available: the phone went by SMS, the email-only buyer by email.
    const messages = await Promise.all(items.map((r) => call<{ message: Record<string, unknown> }>('GET', `/v1/messages/${r.messageId}`)));
    const byCompany = new Map(messages.map((m) => [(m.body.message['company'] as { name: string }).name, m]));
    expect(byCompany.get('Alfa Diesel')!.body.message).toMatchObject({
      channel: 'sms', address: null, company: { id: alfa, name: 'Alfa Diesel' }, purpose: 'outreach', body: 'Hello Alfa Diesel\nReply STOP',
    });
    expect(byCompany.get('Bravo Transport')!.body.message).toMatchObject({
      channel: 'email', address: null, company: { id: bravo, name: 'Bravo Transport' },
    });
    for (const m of messages) for (const leak of ['+1415', 'sales@', 'buy@', '.test']) expect(m.text).not.toContain(leak);

    // The template never saw the number either.
    const rows = await db()<{ variables: Record<string, any> }[]>`select variables from messages where tenant_id = ${TENANT_A}`;
    for (const row of rows) expect(row.variables['contact']).toMatchObject({ phone: null, email: null, telegram: null });

    // Nothing the tenant's webhooks would carry names an address.
    const events = await db()<{ type: string; subject_id: string | null; payload: unknown }[]>`
      select type, subject_id, payload from events where tenant_id = ${TENANT_A}
    `;
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['audience.resolved', 'campaign.run.finished', 'message.queued']));
    for (const event of events) {
      const carried = `${event.subject_id ?? ''} ${JSON.stringify(event.payload)}`;
      for (const leak of ['+1415', 'sales@', 'buy@', '.test']) expect(carried).not.toContain(leak);
    }
    expect(events.find((e) => e.type === 'audience.resolved')!.payload).toMatchObject({
      companies: 2, reachable: 2, unreachable: 0, contacts: 2, created: 2,
    });
  });
});

describe('outreach', () => {
  it('goes out without consent, with the unsubscribe text, and a suppressed buyer is blocked', async () => {
    const alfa = await company('Alfa Diesel', { phones: [us(1)] });
    const bravo = await company('Bravo Transport', { phones: [us(2)] });
    await call('POST', '/v1/suppression', { channel: 'sms', address: us(2), reason: 'complaint' });
    const s1 = await search('sup-1', [{ companyId: alfa, rank: 1 }, { companyId: bravo, rank: 2 }]);
    const id = await campaign(await audience({ requesterRef: 'sup-1', searchIds: [s1] }));
    await drive();

    const { run, items } = await recipientsOf(id);
    expect(run).toMatchObject({ status: 'done', queued: 1, blocked: 1 });
    expect(items.map((r) => [r.company?.name, r.state, r.reason])).toEqual([
      ['Alfa Diesel', 'queued', null],
      ['Bravo Transport', 'blocked', 'suppressed'],
    ].sort((a, b) => String(items.find((r) => r.company?.name === a[0])?.contactId).localeCompare(String(items.find((r) => r.company?.name === b[0])?.contactId))));

    const [sent] = await db()<{ address: string; body: string; status: string }[]>`
      select address, body, status from messages where status = 'queued'
    `;
    expect(sent).toMatchObject({ address: us(1), body: 'Hello Alfa Diesel\nReply STOP' });
    expect(await db()`select 1 from consent`).toHaveLength(0);
  });

  it('defers a Saudi buyer in a quiet hour to the next window', async () => {
    const alfa = await company('Alfa Diesel', { phones: [sa(1)] });
    const bravo = await company('Bravo Transport', { phones: [sa(2)] });
    const s1 = await search('sup-1', [{ companyId: alfa, rank: 1 }, { companyId: bravo, rank: 2 }]);
    await campaign(await audience({ requesterRef: 'sup-1', searchIds: [s1] }));
    const job = await expand();

    const night = await processBatch(job, { now: RIYADH(1, '22:00') });
    expect(night).toMatchObject({ state: 'waiting', processed: 0, deferred: 2, remaining: 2 });
    const waiting = await db()<{ reason: string; not_before: Date }[]>`
      select reason, not_before from campaign_recipients where run_id = ${job.runId}
    `;
    for (const r of waiting) {
      expect(r.reason).toBe('deferred:sa-marketing-sms-hours');
      expect(r.not_before.toISOString()).toBe(RIYADH(2, '09:00').toISOString());
    }

    const morning = await processBatch(job, { now: RIYADH(2, '09:00') });
    expect(morning).toMatchObject({ state: 'done', processed: 2, deferred: 0 });
  });

  it('writes a suppression on unsubscribe, and the next run blocks that buyer', async () => {
    const alfa = await company('Alfa Diesel', { emails: ['sales@alfa-diesel.test'] });
    const s1 = await search('sup-1', [{ companyId: alfa, rank: 1 }]);
    const audienceId = await audience({ requesterRef: 'sup-1', searchIds: [s1] });
    const first = await campaign(audienceId);
    await drive();

    const { items } = await recipientsOf(first);
    expect(items).toEqual([expect.objectContaining({ state: 'queued', email: null })]);
    await processSend(items[0]!.messageId!);
    const delivered = fakeCalls('email')[0]!;
    expect(delivered.to).toBe('sales@alfa-diesel.test');
    expect(delivered.unsubscribeUrl).toContain('/unsubscribe/');

    // The buyer clicks the one-click link.
    const token = delivered.unsubscribeUrl!.split('/unsubscribe/')[1]!;
    const res = await app.fetch(new Request(`http://engine.test/unsubscribe/${token}`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await db()`select 1 from suppression where tenant_id = ${TENANT_A} and address = 'sales@alfa-diesel.test' and reason = 'unsubscribe'`).toHaveLength(1);

    const second = await campaign(audienceId);
    await drive();
    const next = await recipientsOf(second);
    expect(next.run).toMatchObject({ status: 'done', queued: 0, blocked: 1 });
    expect(next.items).toEqual([expect.objectContaining({ state: 'blocked', reason: 'suppressed', email: null })]);
  });
});

describe('pairing', () => {
  it('ties outreach to discovery audiences and discovery audiences to outreach', async () => {
    const alfa = await company('Alfa Diesel', { phones: [us(1)] });
    const s1 = await search('sup-1', [{ companyId: alfa, rank: 1 }]);
    const found = await audience({ requesterRef: 'sup-1', searchIds: [s1] });
    const fixed = (await call<{ audience: { id: string } }>('POST', '/v1/audiences', { name: 'list', kind: 'static' })).body.audience.id;
    const create = (audienceId: string, purpose?: string) =>
      call<{ campaign: { purpose: string } }>('POST', '/v1/campaigns', {
        name: `c-${Math.random()}`, audienceId, template: 'outreach', channel: 'sms', ...(purpose ? { purpose } : {}),
      });

    const outreachToList = await create(fixed, 'outreach');
    expect(outreachToList.status).toBe(400);
    expect(outreachToList.body).toMatchObject({ error: 'purpose_mismatch' });

    const marketingToBuyers = await create(found, 'marketing');
    expect(marketingToBuyers.status).toBe(400);
    expect(marketingToBuyers.body).toMatchObject({ error: 'purpose_mismatch' });

    const single = await call('POST', '/v1/messages', {
      contact: { phone: us(1) }, channel: 'sms', purpose: 'outreach', template: 'outreach', variables: {},
    });
    expect(single.status).toBe(400);
    expect(single.body).toMatchObject({ error: 'purpose_not_allowed' });

    const defaulted = await create(found);
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.campaign.purpose).toBe('outreach');
    const listDefault = await create(fixed);
    expect(listDefault.status).toBe(201);
    expect(listDefault.body.campaign.purpose).toBe('marketing');

    // Nor can an edit cross them over.
    const made = (await call<{ campaign: { id: string } }>('POST', '/v1/campaigns', {
      name: 'edit-me', audienceId: found, template: 'outreach', channel: 'sms', purpose: 'outreach',
    })).body.campaign.id;
    const crossed = await call('PATCH', `/v1/campaigns/${made}`, { audienceId: fixed });
    expect(crossed.status).toBe(400);
    expect(crossed.body).toMatchObject({ error: 'purpose_mismatch' });
  });
});
