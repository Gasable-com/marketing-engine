import type PgBoss from 'pg-boss';
import { db } from '../db/client.js';
import {
  CAMPAIGN_BATCH_JOB,
  CAMPAIGN_RUN_JOB,
  SWEEP_CRON,
  SWEEP_JOB,
  processBatch,
  runCampaign,
  sweepRuns,
  type BatchJob,
  type RunJob,
} from '../modules/campaigns/index.js';
import {
  DISCOVERY_TASK_JOB,
  TASK_RETRY_LIMIT,
  runTask,
  type TaskJob,
} from '../modules/discovery/index.js';
import { SEND_JOB, SEND_RETRY_LIMIT } from '../modules/messaging/index.js';
import { processSend } from '../modules/messaging/worker.js';
import { EXPIRE_JOB, expireReservations } from '../modules/promocodes/index.js';
import { DELIVER_JOB, FANOUT_JOB, deliver, fanOut } from '../modules/webhooks/index.js';
import { span } from '../otel.js';
import { closeQueue, openQueue, queueStarted } from './queue.js';

export { enqueue } from './queue.js';

const NOOP = 'noop';
const IDEMPOTENCY_CLEANUP = 'idempotency.cleanup';

/**
 * Register every worker. `registerWorkers: false` starts the queue without
 * consuming anything, so a test can assert what was enqueued.
 */
export async function startJobs(opts: { registerWorkers?: boolean } = {}): Promise<PgBoss> {
  if (queueStarted()) return openQueue();
  const registerWorkers = opts.registerWorkers ?? true;

  const b = await openQueue();

  for (const name of [NOOP, IDEMPOTENCY_CLEANUP, SEND_JOB, EXPIRE_JOB, FANOUT_JOB, DELIVER_JOB, SWEEP_JOB]) {
    await b.createQueue(name);
  }
  // `short`: while one job with a singleton key is waiting, another with the
  // same key is dropped. A double schedule, or a resume racing the batch it
  // resumes, therefore queues one job, not two. A discovery task is keyed by
  // its own id, so it is never waiting on the queue twice.
  for (const name of [CAMPAIGN_RUN_JOB, CAMPAIGN_BATCH_JOB, DISCOVERY_TASK_JOB]) {
    await b.createQueue(name, { name, policy: 'short' });
  }

  // Schedules are part of what the queue is, not of whether this process
  // consumes it: a second replica that registers no workers should still see
  // the same crons declared.
  await b.schedule(IDEMPOTENCY_CLEANUP, '0 * * * *');
  await b.schedule(EXPIRE_JOB, '*/5 * * * *');
  await b.schedule(SWEEP_JOB, SWEEP_CRON);

  if (!registerWorkers) return b;

  await b.work(NOOP, async () => {});

  await b.work(SEND_JOB, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      const { messageId } = job.data as { messageId: string };
      await withJobLog(SEND_JOB, job.id, () =>
        // pg-boss counts retries from 0, so this is the last attempt when the
        // count has reached the limit.
        processSend(messageId, { finalAttempt: job.retryCount >= SEND_RETRY_LIMIT }),
      );
    }
  });

  await b.work(CAMPAIGN_RUN_JOB, async (jobs) => {
    for (const job of jobs) {
      await withJobLog(CAMPAIGN_RUN_JOB, job.id, () => runCampaign(job.data as RunJob));
    }
  });

  await b.work(CAMPAIGN_BATCH_JOB, async (jobs) => {
    for (const job of jobs) {
      await withJobLog(CAMPAIGN_BATCH_JOB, job.id, () => processBatch(job.data as BatchJob));
    }
  });

  await b.work(DISCOVERY_TASK_JOB, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      await withJobLog(DISCOVERY_TASK_JOB, job.id, () =>
        // Counted from 0 like SEND_JOB: the last attempt is the one at the limit.
        runTask(job.data as TaskJob, { finalAttempt: job.retryCount >= TASK_RETRY_LIMIT }),
      );
    }
  });

  await b.work(FANOUT_JOB, async (jobs) => {
    for (const job of jobs) {
      const { eventId } = job.data as { eventId: string };
      await withJobLog(FANOUT_JOB, job.id, () => fanOut(eventId));
    }
  });

  await b.work(DELIVER_JOB, async (jobs) => {
    for (const job of jobs) {
      const { deliveryId } = job.data as { deliveryId: string };
      await withJobLog(DELIVER_JOB, job.id, () => deliver(deliveryId));
    }
  });

  await b.work(IDEMPOTENCY_CLEANUP, async () => {
    // Runs as the owning role, which is not subject to the RLS policies, so one
    // statement sweeps every tenant.
    const deleted = await db()`
      delete from idempotency_keys where created_at < now() - interval '24 hours'
    `;
    if (deleted.count > 0) console.log(`idempotency.cleanup: deleted ${deleted.count} rows`);
  });

  await b.work(SWEEP_JOB, async (jobs) => {
    for (const job of jobs) {
      // Runs whose job chain died: back on the queue, or finished.
      const touched = await withJobLog(SWEEP_JOB, job.id, () => sweepRuns());
      if (touched.length > 0) console.log(JSON.stringify({ msg: `${SWEEP_JOB}: recovered runs`, touched }));
    }
  });

  await b.work(EXPIRE_JOB, async () => {
    // A cart abandoned at checkout must not hold budget open against every
    // other buyer forever.
    const released = await expireReservations();
    if (released > 0) console.log(`${EXPIRE_JOB}: released ${released} expired reservations`);
  });

  return b;
}

/** One line per job, and one span, whatever the outcome. */
async function withJobLog<T>(name: string, id: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await span('job', { 'job.name': name, 'job.id': id }, fn);
    console.log(JSON.stringify({ msg: 'job', name, id, durationMs: Date.now() - startedAt, ok: true }));
    return result;
  } catch (err) {
    console.log(
      JSON.stringify({
        msg: 'job',
        name,
        id,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: (err as Error).message,
      }),
    );
    throw err;
  }
}

export async function stopJobs(): Promise<void> {
  await closeQueue();
}
