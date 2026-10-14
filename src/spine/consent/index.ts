import type { Tx } from '../../db/client.js';
import { emit } from '../events/index.js';
import { normalize, type Channel, type Purpose } from '../contacts/normalize.js';
import { evaluate } from '../rules/index.js';

export type ConsentStatus = 'granted' | 'revoked';

export type ConsentRow = {
  id: string;
  tenant_id: string;
  channel: string;
  address: string;
  purpose: string;
  status: ConsentStatus;
  source: string;
  recorded_at: Date;
};

export type SuppressionRow = {
  id: string;
  tenant_id: string | null;
  channel: string;
  address: string;
  reason: string;
  created_at: Date;
};

export type CanSendResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'suppressed' | 'no_consent' | 'rule';
      rule?: { id: string; name: string };
    };

/** Append a consent decision. The latest row for a contact and purpose wins. */
export async function record(
  tx: Tx,
  input: {
    tenantId: string;
    channel: Channel;
    address: string;
    purpose: Purpose;
    status: ConsentStatus;
    source: string;
    defaultCountry?: string | undefined;
    /**
     * When the consent was actually given, if that was before now: an import
     * carrying the date on the signed agreement. Defaults to now.
     */
    recordedAt?: Date | undefined;
  },
): Promise<ConsentRow> {
  const contact = normalize(input);

  const [row] = await tx<ConsentRow[]>`
    insert into consent (tenant_id, channel, address, purpose, status, source, recorded_at)
    values (${input.tenantId}, ${contact.channel}, ${contact.address},
            ${input.purpose}, ${input.status}, ${input.source},
            ${input.recordedAt ?? tx`now()`})
    returning *
  `;
  if (!row) throw new Error('consent.record inserted no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: input.status === 'granted' ? 'consent.granted' : 'consent.revoked',
    subjectType: 'contact',
    subjectId: `${contact.channel}:${contact.address}`,
    payload: {
      purpose: input.purpose,
      source: input.source,
      region: contact.region,
      ...(input.recordedAt ? { recordedAt: input.recordedAt.toISOString() } : {}),
    },
  });

  return row;
}

/**
 * Block an address. `tenantId: null` is a platform-wide block and can only be
 * written by the owning role, so it carries no tenant to attribute an event to.
 */
export async function suppress(
  tx: Tx,
  input: {
    tenantId: string | null;
    channel: Channel;
    address: string;
    reason: string;
    defaultCountry?: string | undefined;
  },
): Promise<SuppressionRow | null> {
  const contact = normalize(input);

  const [row] = await tx<SuppressionRow[]>`
    insert into suppression (tenant_id, channel, address, reason)
    values (${input.tenantId}, ${contact.channel}, ${contact.address}, ${input.reason})
    on conflict do nothing
    returning *
  `;
  if (!row) return null; // already suppressed

  if (input.tenantId) {
    await emit(tx, {
      tenantId: input.tenantId,
      type: 'suppression.added',
      subjectType: 'contact',
      subjectId: `${contact.channel}:${contact.address}`,
      payload: { reason: input.reason, region: contact.region },
    });
  }

  return row;
}

/**
 * The one decision point. Suppression, then consent, then the region's rules.
 * `at` defaults to now and exists so callers and tests can pin the clock.
 * Sends nothing; the caller acts on the answer.
 */
export async function canSend(
  tx: Tx,
  input: {
    tenantId: string;
    channel: Channel;
    address: string;
    purpose: Purpose;
    at?: Date | undefined;
    defaultCountry?: string | undefined;
    /**
     * false stops after suppression and consent. Channel selection asks that
     * question of every candidate channel; the sending window is then applied
     * once, to the channel it picked.
     */
    checkRules?: boolean | undefined;
  },
): Promise<CanSendResult> {
  const contact = normalize(input);
  const at = input.at ?? new Date();

  // 1. Suppression: platform-wide blocks and this tenant's own. Scoped in the
  // query as well as by RLS, because callers that run as the owning role (the
  // send worker's fallback) are not subject to the policy.
  const [suppressed] = await tx<{ id: string }[]>`
    select id from suppression
    where channel = ${contact.channel} and address = ${contact.address}
      and (tenant_id is null or tenant_id = ${input.tenantId})
    order by tenant_id nulls first
    limit 1
  `;
  if (suppressed) return { allowed: false, reason: 'suppressed' };

  // 2. Consent, for marketing only. Transactional messages need none, and
  // outreach to a found buyer goes without it: an opt-out above still wins,
  // and the sending window below still applies.
  if (input.purpose === 'marketing') {
    const [latest] = await tx<{ status: ConsentStatus }[]>`
      select status from consent
      where tenant_id = ${input.tenantId}
        and channel = ${contact.channel}
        and address = ${contact.address}
        and purpose = ${input.purpose}
      order by recorded_at desc, id desc
      limit 1
    `;
    if (latest?.status !== 'granted') return { allowed: false, reason: 'no_consent' };
  }

  if (input.checkRules === false) return { allowed: true };

  // 3. Region-scoped sending rules, in the contact's own local time.
  const timezone = await timezoneFor(tx, contact.region);
  const { localHour, weekday } = localTime(at, timezone);

  const verdict = await evaluate(tx, {
    kind: 'sending_window',
    tenantId: input.tenantId,
    region: contact.region,
    context: {
      channel: contact.channel,
      purpose: input.purpose,
      region: contact.region,
      localHour,
      weekday,
    },
  });

  if (verdict.denied && verdict.byRule) {
    return {
      allowed: false,
      reason: 'rule',
      rule: { id: verdict.byRule.id, name: verdict.byRule.name },
    };
  }

  return { allowed: true };
}

/** A region with no row, and an address with no region at all, both fall back to UTC. */
async function timezoneFor(tx: Tx, region: string | null): Promise<string> {
  if (!region) return 'UTC';
  const [row] = await tx<{ timezone: string }[]>`
    select timezone from regions where code = ${region}
  `;
  return row?.timezone ?? 'UTC';
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function localTime(at: Date, timeZone: string): { localHour: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(at);

  const hour = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const day = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';

  return {
    localHour: Number(hour),
    weekday: WEEKDAYS.find((d) => d === day.toLowerCase()) ?? 'sun',
  };
}
