import { withTenant, type Tx } from '../../db/client.js';
import { InvalidAddressError } from '../../spine/contacts/normalize.js';
import { emit } from '../../spine/events/index.js';
import { resolve as resolveCompany } from '../../spine/registry/index.js';
import { MessagingError } from '../messaging/errors.js';
import { preflight, send } from '../messaging/index.js';
import { MAX_AUDIENCE, getAudience, resolveAudience } from './audiences.js';
import {
  BATCH_INTERVAL_SECONDS,
  MAX_RUNNING_PER_TENANT,
  enqueueBatch,
  enqueueRun,
  getCampaign,
  nextRunAt,
  runningCount,
  type CampaignRow,
  type RunRow,
} from './campaigns.js';
import { contactInput, type ContactRow } from './contacts.js';
import { nextSendingWindow } from './window.js';

/** Recipients are written in chunks this size, each in its own transaction. */
const EXPANSION_CHUNK = 1000;

/** How long a run waits when its tenant already has the most campaigns running. */
const BACKPRESSURE_SECONDS = 60;

/** Unexpected errors one recipient may cause before it is skipped. */
export const POISON_ATTEMPTS = 3;

/** Ready recipients read per query while filling a batch. */
const READY_PAGE = 500;

export type RunJob = { tenantId: string; campaignId: string; runNo: number };
export type BatchJob = { tenantId: string; runId: string };

/**
 * `campaign.run`: start run `runNo`, snapshot the audience into recipients,
 * and hand over to the batch worker. Sends nothing: expansion snapshots,
 * batches send.
 *
 * Safe to deliver twice. The run row is unique on (campaign, run_no), so the
 * second delivery either finds the run past expansion and stops, or finds it
 * still expanding and finishes the same snapshot, which inserts nothing twice.
 */
export async function runCampaign(job: RunJob): Promise<void> {
  const started = await withTenant(job.tenantId, (tx) => startRun(tx, job));
  if (!started) return;
  const { campaign, run } = started;

  try {
    const ids = await withTenant(job.tenantId, async (tx) => {
      const audience = await getAudience(tx, campaign.audience_id);
      if (!audience) throw new Error(`audience ${campaign.audience_id} is gone`);
      return resolveAudience(tx, audience, { limit: MAX_AUDIENCE });
    });

    for (let start = 0; start < ids.length; start += EXPANSION_CHUNK) {
      const chunk = ids.slice(start, start + EXPANSION_CHUNK);
      await withTenant(job.tenantId, async (tx) => {
        await tx`
          insert into campaign_recipients (run_id, tenant_id, contact_id, state)
          select ${run.id}, ${job.tenantId}, unnest(${chunk}::uuid[]), 'pending'
          on conflict do nothing
        `;
        await tx`update campaign_runs set last_progress_at = now() where id = ${run.id}`;
      });
    }

    await withTenant(job.tenantId, async (tx) => {
      // Only if still expanding: a cancel while this ran has the last word.
      const [sending] = await tx<RunRow[]>`
        update campaign_runs set
          status = 'sending',
          audience_size = (select count(*)::int from campaign_recipients where run_id = ${run.id}),
          last_progress_at = now()
        where id = ${run.id} and status = 'expanding'
        returning *
      `;
      if (sending) await enqueueBatch(tx, sending);
    });
  } catch (err) {
    await failRun(job.tenantId, campaign, run, (err as Error).message);
  }
}

/**
 * Open the run, or pick up one a previous delivery left expanding. Null when
 * there is nothing to do: the campaign was paused, cancelled or finished, the
 * run is already past expansion, or the tenant has no room and it was put back.
 */
async function startRun(
  tx: Tx,
  job: RunJob,
): Promise<{ campaign: CampaignRow; run: RunRow } | null> {
  const campaign = await getCampaign(tx, job.campaignId, true);
  if (!campaign || (campaign.status !== 'scheduled' && campaign.status !== 'running')) return null;

  const [existing] = await tx<RunRow[]>`
    select * from campaign_runs where campaign_id = ${campaign.id} and run_no = ${job.runNo}
  `;
  if (existing) return existing.status === 'expanding' ? { campaign, run: existing } : null;

  if (
    campaign.status === 'scheduled' &&
    (await runningCount(tx, campaign.tenant_id, campaign.id)) >= MAX_RUNNING_PER_TENANT
  ) {
    await enqueueRun(tx, campaign, job.runNo, new Date(Date.now() + BACKPRESSURE_SECONDS * 1000));
    return null;
  }

  const [run] = await tx<RunRow[]>`
    insert into campaign_runs (tenant_id, campaign_id, run_no, status)
    values (${campaign.tenant_id}, ${campaign.id}, ${job.runNo}, 'expanding')
    on conflict (campaign_id, run_no) do nothing
    returning *
  `;
  if (!run) return null;

  // The next occurrence goes on the queue now, before this run sends
  // anything, so a long run cannot push the next one back.
  const next = nextRunAt(campaign, { after: new Date(), runsSoFar: job.runNo });
  if (next && campaign.recurrence) await enqueueRun(tx, campaign, job.runNo + 1, next);

  const [updated] = await tx<CampaignRow[]>`
    update campaigns set
      status = 'running',
      next_run_at = ${campaign.recurrence ? next : null},
      updated_at = now()
    where id = ${campaign.id}
    returning *
  `;

  await emit(tx, {
    tenantId: campaign.tenant_id,
    type: 'campaign.run.started',
    subjectType: 'campaign',
    subjectId: campaign.id,
    payload: {
      runId: run.id,
      runNo: run.run_no,
      nextRunAt: campaign.recurrence && next ? next.toISOString() : null,
    },
  });

  return { campaign: updated!, run };
}

async function failRun(tenantId: string, campaign: CampaignRow, run: RunRow, error: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx`
      update campaign_runs set status = 'failed', error = ${error}, finished_at = now()
      where id = ${run.id} and status in ('expanding', 'sending')
    `;
    const [failed] = await tx`
      update campaigns set status = 'failed', next_run_at = null, updated_at = now()
      where id = ${campaign.id} and status not in ('cancelled', 'done')
      returning id
    `;
    if (!failed) return;
    await emit(tx, {
      tenantId,
      type: 'campaign.failed',
      subjectType: 'campaign',
      subjectId: campaign.id,
      payload: { runId: run.id, runNo: run.run_no, error },
    });
  });
}

export type BatchOutcome = {
  /**
   * What happened to the run: another batch queued ten seconds out (`sent`),
   * one queued for when the earliest deferred recipient is due (`waiting`),
   * the run finished (`done`), or the chain stopped for a pause or cancel.
   */
  state: 'sent' | 'waiting' | 'paused' | 'done' | 'stopped';
  /** Recipients this batch queued, blocked or skipped. */
  processed: number;
  /** Recipients this batch deferred to a later sending window. */
  deferred: number;
  /** Pending recipients left, deferred ones included. */
  remaining: number;
};

type Outcome = 'queued' | 'blocked' | 'skipped' | 'deferred' | 'taken';

/**
 * `campaign.batch`: work through the recipients that are ready now, then
 * queue the next batch or finish the run.
 *
 * A batch queues, blocks or skips at most a tenth of the campaign's per-minute
 * allowance, so batches ten seconds apart hold the rate. Recipients a sending
 * window holds back are deferred without counting against that allowance:
 * deferring sends nothing. When only deferred recipients are left, the next
 * batch is queued for when the earliest of them is due.
 *
 * Each recipient is its own transaction, locked while it is decided, so two
 * batches for one run can never send to anyone twice. `now` is the clock the
 * whole batch runs at; tests pin it.
 */
export async function processBatch(
  job: BatchJob,
  opts: { now?: Date } = {},
): Promise<BatchOutcome> {
  const now = opts.now ?? new Date();
  const stopped = (state: BatchOutcome['state']): BatchOutcome => ({ state, processed: 0, deferred: 0, remaining: 0 });

  const context = await withTenant(job.tenantId, async (tx) => {
    const [run] = await tx<RunRow[]>`select * from campaign_runs where id = ${job.runId}`;
    const campaign = run ? await getCampaign(tx, run.campaign_id) : undefined;
    return run && campaign ? { run, campaign } : null;
  });
  if (!context || context.run.status !== 'sending') return stopped('stopped');
  const { run, campaign } = context;
  if (campaign.status !== 'running') return stopped(campaign.status === 'paused' ? 'paused' : 'stopped');

  const allowance = Math.ceil(campaign.throttle_per_minute / 6);
  // One window search per (channel, region, purpose) per batch, however many
  // recipients share it.
  const windows = new Map<string, Date | null>();
  let processed = 0;
  let deferred = 0;
  let cursor: string | null = null;

  fill: while (processed < allowance) {
    const after: string | null = cursor;
    const ready: { contact_id: string }[] = await withTenant(job.tenantId, (tx) => tx<{ contact_id: string }[]>`
      select contact_id from campaign_recipients
      where run_id = ${run.id} and state = 'pending'
        and (not_before is null or not_before <= ${now})
        ${after ? tx`and contact_id > ${after}` : tx``}
      order by contact_id
      limit ${READY_PAGE}
    `);
    if (ready.length === 0) break;

    for (const { contact_id } of ready) {
      cursor = contact_id;
      const outcome = await attempt(job.tenantId, campaign, run, contact_id, now, windows);
      if (outcome === 'deferred') deferred += 1;
      else if (outcome !== 'taken') processed += 1;
      if (processed >= allowance) break fill;
    }
  }

  return withTenant(job.tenantId, async (tx) => {
    await tx`update campaign_runs set last_progress_at = now() where id = ${run.id}`;

    const [left] = await tx<{ ready: number; total: number; earliest: Date | null }[]>`
      select count(*) filter (where not_before is null or not_before <= ${now})::int as ready,
             count(*)::int as total,
             min(not_before) filter (where not_before > ${now}) as earliest
      from campaign_recipients
      where run_id = ${run.id} and state = 'pending'
    `;
    const remaining = left?.total ?? 0;

    if (remaining > 0) {
      // Checked again: a pause that landed during the batch stops the chain here.
      const current = await getCampaign(tx, campaign.id);
      if (current?.status !== 'running') {
        return { state: current?.status === 'paused' ? 'paused' : 'stopped', processed, deferred, remaining };
      }
      if ((left?.ready ?? 0) > 0) {
        await enqueueBatch(tx, run, BATCH_INTERVAL_SECONDS);
        return { state: 'sent', processed, deferred, remaining };
      }
      const wait = Math.max(1, Math.ceil((left!.earliest!.getTime() - now.getTime()) / 1000));
      await enqueueBatch(tx, run, wait);
      return { state: 'waiting', processed, deferred, remaining };
    }

    await finishRun(tx, campaign, run.id);
    return { state: 'done', processed, deferred, remaining };
  });
}

/**
 * Decide one recipient, and count an unexpected failure against it.
 *
 * Anything other than a MessagingError or an invalid address is unexpected: a
 * database error, a bug. It is counted in a transaction of its own, since the
 * recipient's own rolled back, and rethrown so pg-boss retries the batch. On
 * the third, the recipient is skipped with the error as its reason and the
 * batch carries on: one bad row must not kill the chain or loop the sweeper.
 */
async function attempt(
  tenantId: string,
  campaign: CampaignRow,
  run: RunRow,
  contactId: string,
  now: Date,
  windows: Map<string, Date | null>,
): Promise<Outcome> {
  try {
    return await withTenant(tenantId, (tx) => decide(tx, tenantId, campaign, run, contactId, now, windows));
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const attempts = await withTenant(tenantId, async (tx) => {
      const [row] = await tx<{ attempts: number }[]>`
        update campaign_recipients set attempts = attempts + 1
        where run_id = ${run.id} and contact_id = ${contactId} and state = 'pending'
        returning attempts
      `;
      if (row && row.attempts >= POISON_ATTEMPTS) {
        await settle(tx, run.id, contactId, 'skipped', `error:${message.slice(0, 200)}`, null);
      }
      return row?.attempts ?? 0;
    });
    if (attempts >= POISON_ATTEMPTS) return 'skipped';
    throw err;
  }
}

/**
 * One recipient. Preflight first: held back only by a sending window, it is
 * deferred to when the window next opens, and nothing is sent or recorded as
 * blocked. Otherwise it goes through messaging.send() exactly as a single API
 * send does: consent, rules, selection, templates and fallback all apply.
 */
async function decide(
  tx: Tx,
  tenantId: string,
  campaign: CampaignRow,
  run: RunRow,
  contactId: string,
  now: Date,
  windows: Map<string, Date | null>,
): Promise<Outcome> {
  const [recipient] = await tx<{ contact_id: string }[]>`
    select contact_id from campaign_recipients
    where run_id = ${run.id} and contact_id = ${contactId} and state = 'pending'
      and (not_before is null or not_before <= ${now})
    for update skip locked
  `;
  if (!recipient) return 'taken';

  const [contact] = await tx<ContactRow[]>`select * from contacts where id = ${contactId}`;
  if (!contact) {
    await settle(tx, run.id, contactId, 'skipped', 'invalid_address', null);
    return 'skipped';
  }

  const verdict = await preflight(tx, {
    tenantId,
    contact: contactInput(contact),
    purpose: campaign.purpose,
    ...(campaign.channel ? { channel: campaign.channel } : {}),
    at: now,
  });

  // Consent and suppression are never deferred: preflight only sets `window`
  // for a channel that passed both and met a closed sending window.
  if (!verdict.allowed && verdict.window) {
    const key = `${verdict.window.channel}|${verdict.window.region ?? ''}|${campaign.purpose}`;
    if (!windows.has(key)) {
      windows.set(
        key,
        await nextSendingWindow(tx, {
          tenantId,
          contact: contactInput(contact),
          purpose: campaign.purpose,
          ...(campaign.channel ? { channel: campaign.channel } : {}),
          from: now,
        }),
      );
    }
    const next = windows.get(key)!;
    if (!next) {
      await settle(tx, run.id, contactId, 'blocked', 'no_sending_window', null);
      return 'blocked';
    }
    await tx`
      update campaign_recipients
      set not_before = ${next}, reason = ${`deferred:${verdict.window.rule.name}`}
      where run_id = ${run.id} and contact_id = ${contactId}
    `;
    return 'deferred';
  }

  const company = contact.company_id ? await resolveCompany(tx, contact.company_id) : undefined;

  let state: 'queued' | 'blocked' | 'skipped';
  let reason: string | null;
  let messageId: string | null = null;
  try {
    // A window that closes between the preflight above and this send comes
    // back from send() as blocked, and is recorded as blocked like any other
    // refusal. The gap is a few milliseconds; it is not worth engineering for.
    const message = await tx.savepoint((sp) =>
      send(sp, {
        tenantId,
        contact: contactInput(contact),
        ...(campaign.channel ? { channel: campaign.channel } : {}),
        purpose: campaign.purpose,
        template: campaign.template,
        variables: {
          ...campaign.variables,
          // A hidden contact's addresses are the engine's to send to, not the
          // template's to show: a found buyer's number never reaches a body.
          contact: {
            id: contact.id,
            name: contact.name,
            locale: contact.locale,
            phone: contact.hidden ? null : contact.phone,
            email: contact.hidden ? null : contact.email,
            telegram: contact.hidden ? null : contact.telegram,
            attributes: contact.attributes,
          },
          company: company ? { id: company.id, name: company.name, country: company.country } : null,
        },
        campaignRunId: run.id,
        at: now,
      }),
    );
    messageId = message.id;
    state = message.status === 'blocked' ? 'blocked' : 'queued';
    reason = message.reason;
  } catch (err) {
    // Not a refusal but an intent that cannot be sent at all: no template
    // for the channel picked, no unsubscribe text, a variable missing.
    if (err instanceof MessagingError) reason = err.code;
    else if (err instanceof InvalidAddressError) reason = 'invalid_address';
    else throw err;
    state = 'skipped';
  }

  await settle(tx, run.id, contactId, state, reason, messageId);
  return state;
}

/** Give a recipient its final state and count it on the run. */
async function settle(
  tx: Tx,
  runId: string,
  contactId: string,
  state: 'queued' | 'blocked' | 'skipped',
  reason: string | null,
  messageId: string | null,
): Promise<void> {
  await tx`
    update campaign_recipients set state = ${state}, reason = ${reason}, message_id = ${messageId}
    where run_id = ${runId} and contact_id = ${contactId}
  `;
  await tx`
    update campaign_runs set
      queued  = queued  + ${state === 'queued' ? 1 : 0},
      blocked = blocked + ${state === 'blocked' ? 1 : 0},
      skipped = skipped + ${state === 'skipped' ? 1 : 0}
    where id = ${runId}
  `;
}

/**
 * Mark the run done, once, and move the campaign on: back to scheduled when a
 * recurrence has another run coming, done when it has not.
 */
export async function finishRun(tx: Tx, campaign: CampaignRow, runId: string): Promise<void> {
  const [done] = await tx<RunRow[]>`
    update campaign_runs set status = 'done', finished_at = now()
    where id = ${runId} and status = 'sending'
      and not exists (
        select 1 from campaign_recipients where run_id = ${runId} and state = 'pending'
      )
    returning *
  `;
  if (!done) return;

  await emit(tx, {
    tenantId: campaign.tenant_id,
    type: 'campaign.run.finished',
    subjectType: 'campaign',
    subjectId: campaign.id,
    payload: {
      runId: done.id,
      runNo: done.run_no,
      audienceSize: done.audience_size,
      queued: done.queued,
      blocked: done.blocked,
      skipped: done.skipped,
    },
  });

  const [busy] = await tx`
    select 1 from campaign_runs
    where campaign_id = ${campaign.id} and status in ('expanding', 'sending')
  `;
  if (busy) return;

  const current = await getCampaign(tx, campaign.id, true);
  if (current?.status !== 'running') return;

  const status = current.next_run_at ? 'scheduled' : 'done';
  await tx`update campaigns set status = ${status}, updated_at = now() where id = ${campaign.id}`;
  if (status === 'done') {
    await emit(tx, {
      tenantId: campaign.tenant_id,
      type: 'campaign.done',
      subjectType: 'campaign',
      subjectId: campaign.id,
      payload: { runs: done.run_no },
    });
  }
}
