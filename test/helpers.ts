import { SignJWT } from 'jose';
import { closeDb, db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { startJobs, stopJobs } from '../src/jobs/index.js';
import { SEND_JOB } from '../src/modules/messaging/index.js';

export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';

/**
 * Migrate, then reset to two known tenants. Runs as the owner, so no RLS.
 *
 * The tenants themselves are kept rather than truncated: `truncate tenants
 * cascade` would follow the foreign keys into `rules` and take the seeded
 * region rule with it, and the seed only runs once.
 */
export async function resetDb(): Promise<void> {
  await migrate();
  await db()`delete from rules where scope = 'tenant'`;
  await db()`
    truncate idempotency_keys, events, consent, suppression,
             messages, templates, tenant_channel_configs,
             tenant_company, company_sources, company_identifiers,
             company_profiles, invites, finder_runs, companies,
             ledger_entries, redemptions, promocodes,
             webhook_deliveries, webhook_endpoints,
             campaign_recipients, campaign_runs, campaigns,
             audience_members, audiences, contacts,
             discovery_results, discovery_tasks, discovery_jobs
             restart identity cascade
  `;
  await clearSendJobs();
  // Tenants a test provisioned through the internal route go too, or the next
  // run finds them already there.
  await db()`delete from tenants where id <> ${TENANT_A} and id <> ${TENANT_B}`;
  await db()`
    insert into tenants (id, name) values
      (${TENANT_A}, 'Tenant A'),
      (${TENANT_B}, 'Tenant B')
    on conflict (id) do nothing
  `;
}

export async function teardownDb(): Promise<void> {
  await stopJobs();
  await closeDb();
}

/**
 * Start the queue without workers, so a test can assert what was enqueued
 * instead of racing the worker that would consume it.
 */
export async function startQueue(): Promise<void> {
  await startJobs({ registerWorkers: false });
}

async function clearSendJobs(): Promise<void> {
  const [exists] = await db()`
    select 1 from information_schema.tables
    where table_schema = 'pgboss' and table_name = 'job'
  `;
  if (exists) {
    await db()`
      delete from pgboss.job
      where name = ${SEND_JOB} or name like 'campaign.%' or name like 'discovery.%'
    `;
  }
}

export async function sendJobCount(): Promise<number> {
  const [row] = await db()<{ count: string }[]>`
    select count(*)::text as count from pgboss.job where name = ${SEND_JOB}
  `;
  return Number(row?.count ?? 0);
}

export async function tokenFor(tenantId: string): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  return new SignJWT({ tenant_id: tenantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}
