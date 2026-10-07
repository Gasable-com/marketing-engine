import { randomBytes } from 'node:crypto';
import { db, type Tx } from '../../db/client.js';
import { env } from '../../env.js';
import { emit } from '../../spine/events/index.js';
import type { Channel } from '../../spine/contacts/normalize.js';
import { foldText, resolve, type CompanyRow } from '../../spine/registry/index.js';
import { send, type ContactInput, type MessageRow } from '../messaging/index.js';
import { activeFinder, type Candidate, type FinderQuery } from './finder/index.js';

export * from './finder/index.js';
export * from './jobs.js';
export { readRow, type RowReading } from './rows.js';
export { Identified } from './prompts.js';
export * from './rfq.js';
export * from './portal.js';
export { assertQuota, quotaFor, type Quota } from './quota.js';
export { pruneSearchCache } from './search/cache.js';
export { setSerperFetch } from './search/serper.js';
export {
  CountrySettingsInput,
  countryCode,
  countryName,
  listCountrySettings,
  saveCountrySettings,
  type CountryRow,
} from './search/country.js';
export { DiscoveryError } from './errors.js';

const DEFAULT_INVITE_DAYS = 14;

import { PROFILE_ROLES, type ProfileRole } from './roles.js';
export { PROFILE_ROLES, type ProfileRole };

export type ProfileRow = {
  company_id: string;
  buys: string[];
  sells: string[];
  sector: string | null;
  city: string | null;
  size: string | null;
  /** Product names in the company's own words, any language. */
  products: string[];
  roles: ProfileRole[];
  cities: string[];
  /** ISO 3166-1 alpha-2, upper case. */
  countries: string[];
  quality: 'full' | 'thin' | null;
  /** When web evidence last filled the profile. */
  profiled_at: Date | null;
  updated_at: Date;
};

export type InviteRow = {
  id: string;
  tenant_id: string;
  company_id: string;
  message_id: string | null;
  token: string;
  status: 'sent' | 'accepted' | 'expired';
  accepted_ref: string | null;
  finder_run_id: string | null;
  created_at: Date;
  accepted_at: Date | null;
  expires_at: Date;
};

export type SearchResult = {
  finder: string;
  /** Pass this back on an invite so the search can be judged by its outcome. */
  finderRunId: number;
  candidates: {
    company: CompanyRow;
    profile: ProfileRow | null;
    view: Record<string, unknown> | null;
    score: number;
    reasons: string[];
  }[];
};

/**
 * Run the active finder, log what was asked and what came back, then fill the
 * answer out with everything the caller needs to act on it.
 */
export async function search(
  tx: Tx,
  input: { tenantId: string; query: FinderQuery },
): Promise<SearchResult> {
  const finder = activeFinder();

  const startedAt = Date.now();
  const candidates = await finder.find(tx, input.tenantId, input.query);
  const durationMs = Date.now() - startedAt;

  const [run] = await tx<{ id: string }[]>`
    insert into finder_runs (tenant_id, finder, query, result_count, duration_ms)
    values (${input.tenantId}, ${finder.name}, ${tx.json(input.query as never)},
            ${candidates.length}, ${durationMs})
    returning id
  `;

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'discovery.searched',
    subjectType: 'search',
    subjectId: finder.name,
    payload: {
      finder: finder.name,
      finderRunId: Number(run!.id),
      query: input.query,
      count: candidates.length,
    },
  });

  return {
    finder: finder.name,
    finderRunId: Number(run!.id),
    candidates: await hydrate(tx, candidates),
  };
}

/**
 * The companies the active finder returns, ids only, logged to finder_runs
 * like any other search. For callers that want the set rather than a page to
 * show: a search audience resolving who it currently means.
 */
export async function findCompanyIds(
  tx: Tx,
  input: { tenantId: string; query: FinderQuery },
): Promise<string[]> {
  const finder = activeFinder();

  const startedAt = Date.now();
  const candidates = await finder.find(tx, input.tenantId, input.query);

  await tx`
    insert into finder_runs (tenant_id, finder, query, result_count, duration_ms)
    values (${input.tenantId}, ${finder.name}, ${tx.json(input.query as never)},
            ${candidates.length}, ${Date.now() - startedAt})
  `;

  return candidates.map((c) => c.companyId);
}

async function hydrate(tx: Tx, candidates: Candidate[]): Promise<SearchResult['candidates']> {
  const filled: SearchResult['candidates'] = [];

  for (const candidate of candidates) {
    const [company] = await tx<CompanyRow[]>`
      select * from companies where id = ${candidate.companyId}
    `;
    if (!company) continue;

    const [profile] = await tx<ProfileRow[]>`
      select * from company_profiles where company_id = ${company.id}
    `;
    // RLS keeps this to the calling tenant's own view.
    const [view] = await tx<Record<string, unknown>[]>`
      select * from tenant_company where company_id = ${company.id}
    `;

    filled.push({
      company,
      profile: profile ?? null,
      view: view ?? null,
      score: candidate.score,
      reasons: candidate.reasons,
    });
  }

  return filled;
}

/** The pool is shared, so any tenant may describe a company in it. */
export async function setProfile(
  tx: Tx,
  input: {
    tenantId: string;
    companyId: string;
    buys?: string[] | undefined;
    sells?: string[] | undefined;
    sector?: string | undefined;
    city?: string | undefined;
    size?: string | undefined;
    products?: string[] | undefined;
    roles?: ProfileRole[] | undefined;
    cities?: string[] | undefined;
    countries?: string[] | undefined;
    quality?: 'full' | 'thin' | undefined;
    profiledAt?: Date | undefined;
    /**
     * Add to what is stored instead of replacing it: lists are unioned
     * (products folded for duplicates and capped at 50), and quality only ever
     * goes up. For web evidence, which sees one side of a company at a time.
     */
    merge?: boolean | undefined;
  },
): Promise<ProfileRow> {
  if (input.merge) return mergeProfile(tx, input);

  // Like the other lists, an empty one leaves what is there: a caller that
  // knows nothing about products does not erase them.
  const [row] = await tx<ProfileRow[]>`
    insert into company_profiles
      (company_id, buys, sells, sector, city, size,
       products, roles, cities, countries, quality, profiled_at)
    values (${input.companyId}, ${input.buys ?? []}, ${input.sells ?? []},
            ${input.sector ?? null}, ${input.city ?? null}, ${input.size ?? null},
            ${input.products ?? []}, ${input.roles ?? []}, ${input.cities ?? []},
            ${input.countries ?? []}, ${input.quality ?? null}, ${input.profiledAt ?? null})
    on conflict (company_id) do update set
      buys   = case when cardinality(excluded.buys) > 0 then excluded.buys
                    else company_profiles.buys end,
      sells  = case when cardinality(excluded.sells) > 0 then excluded.sells
                    else company_profiles.sells end,
      sector = coalesce(excluded.sector, company_profiles.sector),
      city   = coalesce(excluded.city, company_profiles.city),
      size   = coalesce(excluded.size, company_profiles.size),
      products  = case when cardinality(excluded.products) > 0 then excluded.products
                       else company_profiles.products end,
      roles     = case when cardinality(excluded.roles) > 0 then excluded.roles
                       else company_profiles.roles end,
      cities    = case when cardinality(excluded.cities) > 0 then excluded.cities
                       else company_profiles.cities end,
      countries = case when cardinality(excluded.countries) > 0 then excluded.countries
                       else company_profiles.countries end,
      quality     = coalesce(excluded.quality, company_profiles.quality),
      profiled_at = coalesce(excluded.profiled_at, company_profiles.profiled_at),
      updated_at = now()
    returning *
  `;
  if (!row) throw new Error('setProfile wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'company.profiled',
    subjectType: 'company',
    subjectId: input.companyId,
    payload: {
      buys: row.buys,
      sells: row.sells,
      sector: row.sector,
      city: row.city,
      products: row.products,
      roles: row.roles,
      cities: row.cities,
      countries: row.countries,
      quality: row.quality,
      profiledAt: row.profiled_at,
    },
  });

  return row;
}

const MAX_PRODUCTS = 50;

async function mergeProfile(tx: Tx, input: Parameters<typeof setProfile>[1]): Promise<ProfileRow> {
  const [current] = await tx<ProfileRow[]>`select * from company_profiles where company_id = ${input.companyId}`;
  const union = (old: string[] | undefined, add: string[] | undefined, key = (v: string) => v) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of [...(old ?? []), ...(add ?? [])]) {
      const k = key(v);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out;
  };
  const quality =
    current?.quality === 'full' || input.quality === 'full'
      ? 'full'
      : (input.quality ?? current?.quality ?? undefined);

  return setProfile(tx, {
    tenantId: input.tenantId,
    companyId: input.companyId,
    ...(input.buys ? { buys: input.buys } : {}),
    ...(input.sells ? { sells: input.sells } : {}),
    ...(input.sector ? { sector: input.sector } : {}),
    ...(input.city ? { city: input.city } : {}),
    ...(input.size ? { size: input.size } : {}),
    products: union(current?.products, input.products, foldText).slice(0, MAX_PRODUCTS),
    roles: union(current?.roles, input.roles) as ProfileRole[],
    cities: union(current?.cities, input.cities, foldText),
    countries: union(current?.countries, input.countries),
    ...(quality ? { quality } : {}),
    ...(input.profiledAt ? { profiledAt: input.profiledAt } : {}),
  });
}

export type InviteResult =
  | { invite: InviteRow; message: MessageRow }
  | { invite: null; message: MessageRow };

/**
 * An invite is not a special kind of message. It is a transactional message
 * carrying a token, sent through the same door as everything else — so consent
 * and the sending rules apply to it exactly as they do to anything else.
 */
export async function invite(
  tx: Tx,
  input: {
    tenantId: string;
    companyId: string;
    contact: ContactInput;
    channel?: Channel | undefined;
    template: string;
    variables?: Record<string, unknown> | undefined;
    defaultCountry?: string | undefined;
    expiresInDays?: number | undefined;
    /** The search this invite came out of, when it came out of one. */
    finderRunId?: number | undefined;
  },
): Promise<InviteResult> {
  const token = randomBytes(32).toString('base64url');
  const base = env().PUBLIC_BASE_URL.replace(/\/+$/, '');

  const message = await send(tx, {
    tenantId: input.tenantId,
    contact: input.contact,
    ...(input.channel ? { channel: input.channel } : {}),
    purpose: 'transactional',
    template: input.template,
    variables: { ...(input.variables ?? {}), invite_url: `${base}/i/${token}` },
    ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
  });

  // can_send refused, so nothing was sent and there is nothing to accept.
  if (message.status === 'blocked') return { invite: null, message };

  const days = input.expiresInDays ?? DEFAULT_INVITE_DAYS;
  const [row] = await tx<InviteRow[]>`
    insert into invites
      (tenant_id, company_id, message_id, token, status, expires_at, finder_run_id)
    values (${input.tenantId}, ${input.companyId}, ${message.id}, ${token}, 'sent',
            now() + (${days} || ' days')::interval, ${input.finderRunId ?? null})
    returning *
  `;
  if (!row) throw new Error('invite wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'invite.sent',
    subjectType: 'invite',
    subjectId: row.id,
    payload: {
      companyId: input.companyId,
      messageId: message.id,
      expiresAt: row.expires_at,
      finderRunId: row.finder_run_id,
    },
  });

  return { invite: row, message };
}

/** An invite the public redirect may act on: still open, not yet expired. */
export async function openInvite(token: string): Promise<InviteRow | undefined> {
  const [row] = await db()<InviteRow[]>`
    select * from invites
    where token = ${token} and status = 'sent' and expires_at > now()
  `;
  return row;
}

export type AcceptResult =
  | { ok: true; companyId: string; tenantId: string }
  | { ok: false; reason: 'not_found' | 'already_accepted' | 'expired' };

/**
 * The marketplace reporting a signup. Runs as the owning role: this call comes
 * from the marketplace with its own key, not from a tenant with a JWT, and it
 * writes the company's on-platform reference, which is pool-wide.
 */
export async function acceptInvite(input: {
  token: string;
  ref: string;
}): Promise<AcceptResult> {
  return db().begin(async (tx) => {
    const [row] = await tx<InviteRow[]>`
      select * from invites where token = ${input.token} for update
    `;
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'accepted') return { ok: false, reason: 'already_accepted' };
    if (row.status === 'expired' || row.expires_at.getTime() <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }

    await tx`
      update invites set status = 'accepted', accepted_ref = ${input.ref}, accepted_at = now()
      where id = ${row.id}
    `;

    // The company is on the marketplace now: it stays in the pool, and
    // discovery stops suggesting it.
    await tx`
      update companies set on_platform_ref = ${input.ref}, on_platform_at = now(), updated_at = now()
      where id = ${row.company_id}
    `;

    // Nobody else needs to invite a company that has already joined.
    await tx`
      update invites set status = 'expired'
      where company_id = ${row.company_id} and id <> ${row.id} and status = 'sent'
    `;

    await emit(tx, {
      tenantId: row.tenant_id,
      type: 'invite.accepted',
      subjectType: 'invite',
      subjectId: row.id,
      payload: {
        companyId: row.company_id,
        ref: input.ref,
        finderRunId: row.finder_run_id,
      },
    });

    return { ok: true, companyId: row.company_id, tenantId: row.tenant_id };
  }) as Promise<AcceptResult>;
}

/** Follows a merge, so an invite still works after its company was merged away. */
export async function companyForInvite(tx: Tx, companyId: string): Promise<CompanyRow | undefined> {
  return resolve(tx, companyId);
}
