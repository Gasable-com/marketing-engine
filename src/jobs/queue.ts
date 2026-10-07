import PgBoss from 'pg-boss';
import { asOwner, type Tx } from '../db/client.js';
import { env } from '../env.js';

/**
 * The queue itself, with no knowledge of what runs on it. Separate from
 * `jobs/index.ts`, which registers the workers and therefore imports every
 * module: the event spine needs to enqueue, and would otherwise have to import
 * its own consumers.
 */
let boss: PgBoss | undefined;

export function queue(): PgBoss {
  if (!boss) throw new Error('jobs are not started');
  return boss;
}

export function queueStarted(): boolean {
  return boss !== undefined;
}

export async function openQueue(): Promise<PgBoss> {
  if (boss) return boss;
  const b = new PgBoss({ connectionString: env().DATABASE_URL });
  b.on('error', (err) => console.error('pg-boss error', err));
  await b.start();
  boss = b;
  return b;
}

export async function closeQueue(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = undefined;
  await b.stop({ graceful: true });
}

export type EnqueueOptions = {
  retryLimit?: number;
  retryBackoff?: boolean;
  startAfterSeconds?: number;
  /** On a `short` queue, a second job with the same key is dropped while the first waits. */
  singletonKey?: string;
  /** How long a started job may run before pg-boss gives up on it (default 15 minutes). */
  expireInSeconds?: number;
};

/**
 * Enqueue on the caller's transaction, so the job row commits with whatever
 * the caller was writing or not at all. A worker can never see a job whose
 * subject was rolled back.
 */
export async function enqueue(
  tx: Tx,
  name: string,
  data: object = {},
  options: EnqueueOptions = {},
): Promise<string | null> {
  const b = queue();

  // The queue is infrastructure the API role does not own: marketing_app has
  // no rights in the pgboss schema, and giving it some would tie us to
  // pg-boss's table layout.
  return asOwner(tx, () =>
    b.send(name, data, {
      db: onTransaction(tx),
      ...(options.retryLimit !== undefined ? { retryLimit: options.retryLimit } : {}),
      ...(options.retryBackoff !== undefined ? { retryBackoff: options.retryBackoff } : {}),
      ...(options.startAfterSeconds !== undefined
        ? { startAfter: options.startAfterSeconds }
        : {}),
      ...(options.singletonKey !== undefined ? { singletonKey: options.singletonKey } : {}),
      ...(options.expireInSeconds !== undefined ? { expireInSeconds: options.expireInSeconds } : {}),
    }),
  );
}

/**
 * Cancel the job with this singleton key that is still waiting to start, on
 * the caller's transaction. A job already running is left alone; its worker
 * reads the state it acts on and stops by itself. Returns how many it cancelled.
 */
export async function cancelWaiting(tx: Tx, name: string, singletonKey: string): Promise<number> {
  const b = queue();
  return asOwner(tx, async () => {
    const rows = await tx<{ id: string }[]>`
      select id::text as id from pgboss.job
      where name = ${name} and singleton_key = ${singletonKey} and state in ('created', 'retry')
    `;
    if (rows.length === 0) return 0;
    await b.cancel(name, rows.map((r) => r.id), { db: onTransaction(tx) });
    return rows.length;
  });
}

/** pg-boss speaks to whatever exposes executeSql; hand it the open transaction. */
function onTransaction(tx: Tx): PgBoss.Db {
  return {
    async executeSql(text: string, values: unknown[]) {
      // pg-boss leaves optional parameters undefined; postgres.js rejects
      // those outright, so they become explicit nulls.
      const params = values.map((v) => (v === undefined ? null : v));
      const rows = await tx.unsafe(text, params as never[]);
      return { rows: rows as unknown[] };
    },
  };
}
