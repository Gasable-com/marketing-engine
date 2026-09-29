import type { Tx } from '../../db/client.js';
import { cancelWaiting, enqueue } from '../../jobs/queue.js';
import type { Channel, Purpose } from '../../spine/contacts/normalize.js';
import { emit } from '../../spine/events/index.js';
import { configuredChannels, messageStatuses, templateChannels } from '../messaging/index.js';
import { anySendable, getAudience } from './audiences.js';
import { CronError, isTimeZone, nextOccurrence, parseCron } from './cron.js';
import { CampaignError } from './errors.js';

export const CAMPAIGN_RUN_JOB = 'campaign.run';
export const CAMPAIGN_BATCH_JOB = 'campaign.batch';

/**
 * At most this many of one tenant's campaigns may be `running` at once. The
 * crude backpressure that keeps one tenant from monopolising the queue.
 */
export const MAX_RUNNING_PER_TENANT = 5;

/** A batch job's spacing. Each batch sends a tenth of a minute's allowance. */
export const BATCH_INTERVAL_SECONDS = 10;

/**
 * pg-boss attempts per campaign job before it gives up. A chain that dies
 * anyway is picked up by `campaign.sweep`.
 */
export const JOB_RETRY_LIMIT = 3;

export type Recurrence = { cron: string; endsAt?: string | undefined; maxRuns?: number | undefined };

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'failed';

export type CampaignRow = {
  id: string;
  tenant_id: string;
  name: string;
  audience_id: string;
  template: string;
  channel: Channel | null;
  purpose: Purpose;
  variables: Record<string, unknown>;
  scheduled_at: Date | null;
  recurrence: Recurrence | null;
  timezone: string;
  throttle_per_minute: number;
  status: CampaignStatus;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type RunRow = {
  id: string;
  tenant_id: string;
  campaign_id: string;
  run_no: number;
  started_at: Date;
  finished_at: Date | null;
  status: 'expanding' | 'sending' | 'done' | 'cancelled' | 'failed';
  audience_size: number | null;
  queued: number;
  blocked: number;
  skipped: number;
  error: string | null;
  last_progress_at: Date;
};

export type CampaignInput = {
  name: string;
  audienceId: string;
  template: string;
  channel?: Channel | null | undefined;
  purpose: Purpose;
  variables?: Record<string, unknown> | undefined;
  scheduledAt?: Date | null | undefined;
  recurrence?: Recurrence | null | undefined;
  timezone?: string | undefined;
  throttlePerMinute?: number | undefined;
};

/**
 * Everything create checks that a campaign must still satisfy when edited.
 * `checkScheduledAt: false` skips the future check, for an edit that leaves
 * a recurring campaign's long-past start alone.
 */
async function validate(
  tx: Tx,
  tenantId: string,
  input: CampaignInput,
  opts: { checkScheduledAt?: boolean } = {},
): Promise<void> {
  const audience = await getAudience(tx, input.audienceId);
  if (!audience || audience.tenant_id !== tenantId) {
    throw new CampaignError('audience_not_found', 404, 'no such audience');
  }

  // With a named channel the template must exist for it. Without one,
  // selection may pick any channel the tenant has a provider for, so the
  // template must exist for every one of them.
  const have = await templateChannels(tx, tenantId, input.template);
  const need = input.channel ? [input.channel] : await configuredChannels(tx, tenantId);
  const missing = need.filter((c) => !have.includes(c));
  if (missing.length || have.length === 0) {
    throw new CampaignError(
      'template_not_found',
      400,
      `no template named ${input.template} for ${missing.length ? missing.join(', ') : 'any channel'}`,
      { missing },
    );
  }

  const timezone = input.timezone ?? 'Asia/Riyadh';
  if (!isTimeZone(timezone)) throw new CampaignError('invalid_timezone', 400, `unknown time zone ${timezone}`);

  if (input.recurrence) {
    try {
      parseCron(input.recurrence.cron);
    } catch (err) {
      if (err instanceof CronError) throw new CampaignError('invalid_cron', 400, err.message);
      throw err;
    }
  }

  if ((opts.checkScheduledAt ?? true) && input.scheduledAt && input.scheduledAt.getTime() <= Date.now()) {
    throw new CampaignError('scheduled_at_past', 400, 'scheduledAt must be in the future');
  }
}

export async function createCampaign(
  tx: Tx,
  input: CampaignInput & { tenantId: string; duplicatedFrom?: string },
): Promise<CampaignRow> {
  await validate(tx, input.tenantId, input);

  const [row] = await tx<CampaignRow[]>`
    insert into campaigns
      (tenant_id, name, audience_id, template, channel, purpose, variables,
       scheduled_at, recurrence, timezone, throttle_per_minute, status)
    values (${input.tenantId}, ${input.name}, ${input.audienceId}, ${input.template},
            ${input.channel ?? null}, ${input.purpose},
            ${tx.json((input.variables ?? {}) as never)},
            ${input.scheduledAt ?? null},
            ${input.recurrence ? tx.json(input.recurrence as never) : null},
            ${input.timezone ?? 'Asia/Riyadh'}, ${input.throttlePerMinute ?? 60}, 'draft')
    returning *
  `;
  if (!row) throw new Error('createCampaign wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'campaign.created',
    subjectType: 'campaign',
    subjectId: row.id,
    payload: {
      name: row.name,
      audienceId: row.audience_id,
      purpose: row.purpose,
      ...(input.duplicatedFrom ? { duplicatedFrom: input.duplicatedFrom } : {}),
    },
  });
  return row;
}

export async function getCampaign(tx: Tx, id: string, lock = false): Promise<CampaignRow | undefined> {
  const [row] = lock
    ? await tx<CampaignRow[]>`select * from campaigns where id = ${id} for update`
    : await tx<CampaignRow[]>`select * from campaigns where id = ${id}`;
  return row;
}

/**
 * A draft, or a paused campaign between runs, can be edited. A run that is
 * expanding or sending is never changed under it: the edit waits for the next
 * run, and `campaign.edited` records which run that is.
 */
export async function patchCampaign(
  tx: Tx,
  input: { [K in keyof CampaignInput]?: CampaignInput[K] | undefined } & { tenantId: string; id: string },
): Promise<CampaignRow | undefined> {
  const existing = await getCampaign(tx, input.id, true);
  if (!existing) return undefined;
  const between = existing.status === 'paused' && !(await hasActiveRun(tx, existing.id));
  if (existing.status !== 'draft' && !between) {
    throw new CampaignError(
      'not_editable',
      409,
      existing.status === 'paused'
        ? 'a run is in progress; it can be edited once that run finishes'
        : `campaign is ${existing.status}; only a draft, or a paused campaign between runs, can be edited`,
    );
  }

  const merged: CampaignInput = {
    name: input.name ?? existing.name,
    audienceId: input.audienceId ?? existing.audience_id,
    template: input.template ?? existing.template,
    channel: input.channel === undefined ? existing.channel : input.channel,
    purpose: input.purpose ?? existing.purpose,
    variables: input.variables ?? existing.variables,
    scheduledAt: input.scheduledAt === undefined ? existing.scheduled_at : input.scheduledAt,
    recurrence: input.recurrence === undefined ? existing.recurrence : input.recurrence,
    timezone: input.timezone ?? existing.timezone,
    throttlePerMinute: input.throttlePerMinute ?? existing.throttle_per_minute,
  };
  // A draft's start is checked as create checks it. A paused campaign's is
  // checked only when this edit sets it: a recurrence's start is usually past.
  await validate(tx, input.tenantId, merged, {
    checkScheduledAt: existing.status === 'draft' || input.scheduledAt !== undefined,
  });

  const runsSoFar = await lastRunNo(tx, existing.id);
  let nextRun = existing.next_run_at;
  if (between) {
    // Whatever run was waiting was queued for the old settings. Resume queues
    // the next one for the new `next_run_at`, or finishes if there is none.
    await cancelWaiting(tx, CAMPAIGN_RUN_JOB, runKey(existing.id, runsSoFar + 1));
    nextRun = nextRunAt(
      {
        recurrence: merged.recurrence ?? null,
        scheduled_at: merged.scheduledAt ?? null,
        timezone: merged.timezone!,
      },
      { after: new Date(), runsSoFar },
    );
  }

  const [row] = await tx<CampaignRow[]>`
    update campaigns set
      name = ${merged.name}, audience_id = ${merged.audienceId}, template = ${merged.template},
      channel = ${merged.channel ?? null}, purpose = ${merged.purpose},
      variables = ${tx.json((merged.variables ?? {}) as never)},
      scheduled_at = ${merged.scheduledAt ?? null},
      recurrence = ${merged.recurrence ? tx.json(merged.recurrence as never) : null},
      timezone = ${merged.timezone!}, throttle_per_minute = ${merged.throttlePerMinute!},
      next_run_at = ${nextRun},
      updated_at = now()
    where id = ${input.id}
    returning *
  `;

  const changes = diff(existing, row!);
  if (Object.keys(changes).length) {
    await emit(tx, {
      tenantId: input.tenantId,
      type: 'campaign.edited',
      subjectType: 'campaign',
      subjectId: existing.id,
      payload: { status: existing.status, appliesFromRun: runsSoFar + 1, changes },
    });
  }
  return row;
}

/** The editable fields, by their API name. */
const EDITABLE = {
  name: 'name',
  audienceId: 'audience_id',
  template: 'template',
  channel: 'channel',
  purpose: 'purpose',
  variables: 'variables',
  scheduledAt: 'scheduled_at',
  recurrence: 'recurrence',
  timezone: 'timezone',
  throttlePerMinute: 'throttle_per_minute',
} as const satisfies Record<string, keyof CampaignRow>;

/** `{ field: { from, to } }` for each editable field that differs. */
function diff(before: CampaignRow, after: CampaignRow): Record<string, { from: unknown; to: unknown }> {
  const plain = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? null);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, column] of Object.entries(EDITABLE)) {
    const from = plain(before[column]);
    const to = plain(after[column]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  return changes;
}

async function hasActiveRun(tx: Tx, campaignId: string): Promise<boolean> {
  const [row] = await tx`
    select 1 from campaign_runs
    where campaign_id = ${campaignId} and status in ('expanding', 'sending')
    limit 1
  `;
  return row !== undefined;
}

/**
 * When the next run should start, or null when there is none. For a one-shot
 * that is its scheduled time (or now); for a recurrence the next cron time in
 * the campaign's zone after `after`, unless maxRuns or endsAt say it is over.
 */
export function nextRunAt(
  campaign: Pick<CampaignRow, 'recurrence' | 'scheduled_at' | 'timezone'>,
  input: { after: Date; runsSoFar: number },
): Date | null {
  const recurrence = campaign.recurrence;
  if (!recurrence) {
    if (input.runsSoFar > 0) return null;
    return campaign.scheduled_at && campaign.scheduled_at > input.after ? campaign.scheduled_at : input.after;
  }

  if (recurrence.maxRuns !== undefined && input.runsSoFar >= recurrence.maxRuns) return null;

  // A recurrence with a scheduledAt starts no earlier than it.
  const notBefore =
    campaign.scheduled_at && campaign.scheduled_at > input.after
      ? new Date(campaign.scheduled_at.getTime() - 1)
      : input.after;
  const next = nextOccurrence(parseCron(recurrence.cron), notBefore, campaign.timezone);
  if (!next) return null;
  if (recurrence.endsAt && next.getTime() > new Date(recurrence.endsAt).getTime()) return null;
  return next;
}

/** The singleton key of run `runNo`'s job. */
function runKey(campaignId: string, runNo: number): string {
  return `campaign:${campaignId}:${runNo}`;
}

/** Enqueue run `runNo` for `at`. Singleton-keyed, so asking twice queues once. */
export async function enqueueRun(
  tx: Tx,
  campaign: Pick<CampaignRow, 'id' | 'tenant_id'>,
  runNo: number,
  at: Date,
): Promise<void> {
  await enqueue(
    tx,
    CAMPAIGN_RUN_JOB,
    { tenantId: campaign.tenant_id, campaignId: campaign.id, runNo },
    {
      startAfterSeconds: Math.max(0, Math.ceil((at.getTime() - Date.now()) / 1000)),
      singletonKey: runKey(campaign.id, runNo),
      retryLimit: JOB_RETRY_LIMIT,
      retryBackoff: true,
    },
  );
}

/** Enqueue the next batch of a run. One pending batch per run at most. */
export async function enqueueBatch(
  tx: Tx,
  run: Pick<RunRow, 'id' | 'tenant_id'>,
  startAfterSeconds = 0,
): Promise<void> {
  await enqueue(
    tx,
    CAMPAIGN_BATCH_JOB,
    { tenantId: run.tenant_id, runId: run.id },
    {
      startAfterSeconds,
      singletonKey: `campaign-run:${run.id}`,
      retryLimit: JOB_RETRY_LIMIT,
      retryBackoff: true,
    },
  );
}

export async function runningCount(tx: Tx, tenantId: string, except?: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from campaigns
    where tenant_id = ${tenantId} and status = 'running'
      ${except ? tx`and id <> ${except}` : tx``}
  `;
  return row?.n ?? 0;
}

async function lastRunNo(tx: Tx, campaignId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select coalesce(max(run_no), 0)::int as n from campaign_runs where campaign_id = ${campaignId}
  `;
  return row?.n ?? 0;
}

function assertRoom(running: number): void {
  if (running >= MAX_RUNNING_PER_TENANT) {
    throw new CampaignError(
      'too_many_running',
      409,
      `at most ${MAX_RUNNING_PER_TENANT} campaigns may be running at once`,
    );
  }
}

/** draft → scheduled, with the first run on the queue. */
export async function scheduleCampaign(
  tx: Tx,
  input: { tenantId: string; id: string },
): Promise<CampaignRow | undefined> {
  const campaign = await getCampaign(tx, input.id, true);
  if (!campaign) return undefined;
  if (campaign.status !== 'draft') {
    throw new CampaignError('not_draft', 409, `campaign is ${campaign.status}; only a draft can be scheduled`);
  }
  if (campaign.scheduled_at && campaign.scheduled_at.getTime() <= Date.now()) {
    throw new CampaignError('scheduled_at_past', 400, 'scheduledAt has passed; edit the draft first');
  }
  assertRoom(await runningCount(tx, input.tenantId));

  const at = nextRunAt(campaign, { after: new Date(), runsSoFar: 0 });
  if (!at) throw new CampaignError('recurrence_never_fires', 400, 'the recurrence has no future run');

  // Refuse rather than run and block everyone. Asked at the time it will run,
  // so a sending window is judged for then, not for now.
  if (campaign.purpose === 'marketing') {
    const audience = await getAudience(tx, campaign.audience_id);
    const reachable = await anySendable(tx, {
      tenantId: input.tenantId,
      audience: audience!,
      purpose: campaign.purpose,
      ...(campaign.channel ? { channel: campaign.channel } : {}),
      at,
    });
    if (!reachable) {
      throw new CampaignError(
        'audience_empty',
        400,
        'nobody in this audience can be sent marketing on this campaign; preview the audience to see why',
      );
    }
  }

  const [row] = await tx<CampaignRow[]>`
    update campaigns set status = 'scheduled', next_run_at = ${at}, updated_at = now()
    where id = ${input.id}
    returning *
  `;
  await enqueueRun(tx, campaign, 1, at);

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'campaign.scheduled',
    subjectType: 'campaign',
    subjectId: campaign.id,
    payload: { runNo: 1, runAt: at.toISOString() },
  });
  return row;
}

/**
 * scheduled or paused → draft, while nothing has run. The waiting run job goes
 * too: it is singleton-keyed, so left behind it would swallow the next
 * schedule's job and fire at the old time.
 */
export async function unscheduleCampaign(
  tx: Tx,
  input: { tenantId: string; id: string },
): Promise<CampaignRow | undefined> {
  const campaign = await getCampaign(tx, input.id, true);
  if (!campaign) return undefined;
  if (campaign.status !== 'scheduled' && campaign.status !== 'paused') {
    throw new CampaignError('invalid_state', 409, `campaign is ${campaign.status}; it cannot be unscheduled`);
  }
  if ((await lastRunNo(tx, campaign.id)) > 0) {
    throw new CampaignError(
      'already_started',
      409,
      'a run has started; pause it and edit between runs, or duplicate it',
    );
  }

  await cancelWaiting(tx, CAMPAIGN_RUN_JOB, runKey(campaign.id, 1));
  const [row] = await tx<CampaignRow[]>`
    update campaigns set status = 'draft', next_run_at = null, updated_at = now()
    where id = ${input.id}
    returning *
  `;
  await emit(tx, {
    tenantId: input.tenantId,
    type: 'campaign.unscheduled',
    subjectType: 'campaign',
    subjectId: campaign.id,
    payload: { from: campaign.status },
  });
  return row;
}

/**
 * A new draft copied from any campaign, finished or not. It goes through
 * create, so a template deleted since is refused rather than copied.
 */
export async function duplicateCampaign(
  tx: Tx,
  input: { tenantId: string; id: string; name?: string | undefined },
): Promise<CampaignRow | undefined> {
  const source = await getCampaign(tx, input.id);
  if (!source) return undefined;

  const future = source.scheduled_at && source.scheduled_at.getTime() > Date.now();
  return createCampaign(tx, {
    tenantId: input.tenantId,
    duplicatedFrom: source.id,
    name: input.name ?? `${source.name} (copy)`.slice(0, 200),
    audienceId: source.audience_id,
    template: source.template,
    channel: source.channel,
    purpose: source.purpose,
    variables: source.variables,
    scheduledAt: future ? source.scheduled_at : null,
    recurrence: source.recurrence,
    timezone: source.timezone,
    throttlePerMinute: source.throttle_per_minute,
  });
}

/** scheduled or running → paused. Pending recipients stay pending. */
export async function pauseCampaign(
  tx: Tx,
  input: { tenantId: string; id: string },
): Promise<CampaignRow | undefined> {
  const campaign = await getCampaign(tx, input.id, true);
  if (!campaign) return undefined;
  if (campaign.status !== 'scheduled' && campaign.status !== 'running') {
    throw new CampaignError('invalid_state', 409, `campaign is ${campaign.status}; it cannot be paused`);
  }

  const [row] = await tx<CampaignRow[]>`
    update campaigns set status = 'paused', updated_at = now() where id = ${input.id} returning *
  `;
  await emit(tx, {
    tenantId: input.tenantId,
    type: 'campaign.paused',
    subjectType: 'campaign',
    subjectId: campaign.id,
    payload: { from: campaign.status },
  });
  return row;
}

/**
 * paused → running when a run was in progress, else → scheduled. Whatever the
 * pause stopped is put back on the queue; singleton keys make that a no-op
 * when the job it would add is still waiting.
 */
export async function resumeCampaign(
  tx: Tx,
  input: { tenantId: string; id: string },
): Promise<CampaignRow | undefined> {
  const campaign = await getCampaign(tx, input.id, true);
  if (!campaign) return undefined;
  if (campaign.status !== 'paused') {
    throw new CampaignError('invalid_state', 409, `campaign is ${campaign.status}; only a paused one resumes`);
  }

  const active = await tx<RunRow[]>`
    select * from campaign_runs
    where campaign_id = ${campaign.id} and status in ('expanding', 'sending')
    order by run_no
  `;

  let status: CampaignStatus;
  if (active.length) {
    assertRoom(await runningCount(tx, input.tenantId, campaign.id));
    status = 'running';
    for (const run of active) {
      if (run.status === 'sending') await enqueueBatch(tx, run);
      else await enqueueRun(tx, campaign, run.run_no, new Date());
    }
  } else if (campaign.next_run_at) {
    status = 'scheduled';
    await enqueueRun(tx, campaign, (await lastRunNo(tx, campaign.id)) + 1, campaign.next_run_at);
  } else {
    status = 'done';
  }

  const [row] = await tx<CampaignRow[]>`
    update campaigns set status = ${status}, updated_at = now() where id = ${input.id} returning *
  `;
  await emit(tx, {
    tenantId: input.tenantId,
    type: 'campaign.resumed',
    subjectType: 'campaign',
    subjectId: campaign.id,
    payload: { to: status },
  });
  return row;
}

/**
 * Stop for good. Pending recipients are skipped with reason `cancelled`;
 * messages already queued are real sends and are not recalled.
 */
export async function cancelCampaign(
  tx: Tx,
  input: { tenantId: string; id: string },
): Promise<CampaignRow | undefined> {
  const campaign = await getCampaign(tx, input.id, true);
  if (!campaign) return undefined;
  if (['done', 'cancelled', 'failed'].includes(campaign.status)) {
    throw new CampaignError('invalid_state', 409, `campaign is already ${campaign.status}`);
  }

  const runs = await tx<RunRow[]>`
    update campaign_runs set status = 'cancelled', finished_at = now()
    where campaign_id = ${campaign.id} and status in ('expanding', 'sending')
    returning *
  `;

  let skipped = 0;
  for (const run of runs) {
    const moved = await tx`
      update campaign_recipients set state = 'skipped', reason = 'cancelled'
      where run_id = ${run.id} and state = 'pending'
    `;
    await tx`update campaign_runs set skipped = skipped + ${moved.count} where id = ${run.id}`;
    skipped += moved.count;
  }

  const [row] = await tx<CampaignRow[]>`
    update campaigns set status = 'cancelled', next_run_at = null, updated_at = now()
    where id = ${input.id}
    returning *
  `;
  await emit(tx, {
    tenantId: input.tenantId,
    type: 'campaign.cancelled',
    subjectType: 'campaign',
    subjectId: campaign.id,
    payload: { from: campaign.status, skipped, runIds: runs.map((r) => r.id) },
  });
  return row;
}

export async function listCampaigns(
  tx: Tx,
  input: { status?: CampaignStatus | undefined },
): Promise<{ campaign: CampaignRow; lastRun: RunCounts | null }[]> {
  const rows = await tx<CampaignRow[]>`
    select * from campaigns
    where true ${input.status ? tx`and status = ${input.status}` : tx``}
    order by created_at desc, id desc
  `;
  const last = await latestRuns(tx, rows.map((r) => r.id));
  return rows.map((campaign) => ({ campaign, lastRun: last.get(campaign.id) ?? null }));
}

/** A run with its live counts. `deferred` is the part of `pending` waiting on a sending window. */
export type RunCounts = RunRow & { pending: number; deferred: number };

/** The newest run of each campaign, with its pending count. */
export async function latestRuns(tx: Tx, campaignIds: string[]): Promise<Map<string, RunCounts>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await tx<RunCounts[]>`
    select distinct on (r.campaign_id) r.*, ${pendingCounts(tx)}
    from campaign_runs r
    where r.campaign_id = any(${campaignIds}::uuid[])
    order by r.campaign_id, r.run_no desc
  `;
  return new Map(rows.map((r) => [r.campaign_id, r]));
}

function pendingCounts(tx: Tx) {
  return tx`
    (select count(*)::int from campaign_recipients p
     where p.run_id = r.id and p.state = 'pending') as pending,
    (select count(*)::int from campaign_recipients p
     where p.run_id = r.id and p.state = 'pending' and p.not_before > now()) as deferred
  `;
}

export async function listRuns(tx: Tx, campaignId: string): Promise<RunCounts[]> {
  return tx<RunCounts[]>`
    select r.*, ${pendingCounts(tx)}
    from campaign_runs r
    where r.campaign_id = ${campaignId}
    order by r.run_no desc
  `;
}

export type RecipientView = {
  contactId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  state: 'pending' | 'queued' | 'blocked' | 'skipped';
  reason: string | null;
  /** A pending recipient waiting on a sending window: not tried before this. */
  notBefore: Date | null;
  messageId: string | null;
  message: {
    channel: string;
    status: string;
    blockedReason: string | null;
    error: string | null;
    updatedAt: Date;
  } | null;
};

/**
 * Who got it, who didn't, and why, in one call: each recipient with where its
 * message stands now. Ordered by contact id; the cursor is the last one.
 */
export async function listRecipients(
  tx: Tx,
  input: {
    runId: string;
    state?: RecipientView['state'] | undefined;
    limit: number;
    cursor?: string | undefined;
  },
): Promise<RecipientView[]> {
  const rows = await tx<
    {
      contact_id: string;
      state: RecipientView['state'];
      reason: string | null;
      not_before: Date | null;
      message_id: string | null;
      name: string | null;
      phone: string | null;
      email: string | null;
      telegram: string | null;
    }[]
  >`
    select r.contact_id, r.state, r.reason, r.not_before, r.message_id,
           c.name, c.phone, c.email, c.telegram
    from campaign_recipients r
    join contacts c on c.id = r.contact_id
    where r.run_id = ${input.runId}
      ${input.state ? tx`and r.state = ${input.state}` : tx``}
      ${input.cursor ? tx`and r.contact_id > ${input.cursor}` : tx``}
    order by r.contact_id
    limit ${input.limit}
  `;

  const statuses = await messageStatuses(
    tx,
    rows.flatMap((r) => (r.message_id ? [r.message_id] : [])),
  );

  return rows.map((r) => {
    const message = r.message_id ? statuses.get(r.message_id) : undefined;
    return {
      contactId: r.contact_id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      telegram: r.telegram,
      state: r.state,
      reason: r.reason,
      notBefore: r.not_before,
      messageId: r.message_id,
      message: message
        ? {
            channel: message.channel,
            status: message.status,
            blockedReason: message.blockedReason,
            error: message.error,
            updatedAt: message.updatedAt,
          }
        : null,
    };
  });
}
