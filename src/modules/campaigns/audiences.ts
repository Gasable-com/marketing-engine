import type { Tx } from '../../db/client.js';
import type { Channel, Purpose } from '../../spine/contacts/normalize.js';
import { emit } from '../../spine/events/index.js';
import { contactIdentifiers } from '../../spine/registry/index.js';
import {
  findCompanyIds,
  ownSearchStatuses,
  rankedCompanies,
  type FinderQuery,
} from '../discovery/index.js';
import { configuredChannels, preflight } from '../messaging/index.js';
import {
  contactInput,
  contactsWithCompany,
  presentContact,
  upsertContact,
  type ContactFields,
  type ContactRow,
} from './contacts.js';
import { CampaignError } from './errors.js';

/**
 * The most contacts one audience resolves to. A run snapshots every one of
 * them, so this is also the largest campaign run. A number to revisit.
 */
export const MAX_AUDIENCE = 100_000;

/** How many companies a search audience asks the finder for. */
export const MAX_SEARCH_COMPANIES = 10_000;

/** The most searches one discovery audience draws on. */
export const MAX_AUDIENCE_SEARCHES = 20;

export type ContactFilter = {
  /** The contact has an address for at least one of these. */
  hasChannel?: Channel[] | undefined;
  /** The contact's `attributes.tags` holds at least one of these. */
  tags?: string[] | undefined;
  companyIds?: string[] | undefined;
};

export type SearchDefinition = {
  finderQuery: Omit<FinderQuery, 'limit'> & { limit?: number | undefined };
  contactFilter?: ContactFilter | undefined;
};

export type DiscoveryFit = 'strong' | 'weak';

/**
 * A discovery audience: the buyers a requester's finished searches found.
 * The portal sets `requesterRef` from its session, so one supplier's
 * audience can only draw on that supplier's own searches.
 */
export type DiscoveryDefinition = {
  requesterRef: string;
  searchIds: string[];
  fit: DiscoveryFit[];
  /** Buyers the supplier unticked, by company id. */
  excludeCompanyIds?: string[] | undefined;
};

export type AudienceDefinition = SearchDefinition | DiscoveryDefinition;

export function isDiscoveryDefinition(definition: AudienceDefinition): definition is DiscoveryDefinition {
  return 'searchIds' in definition;
}

export type AudienceKind = 'static' | 'search' | 'discovery';

export type AudienceRow = {
  id: string;
  tenant_id: string;
  name: string;
  kind: AudienceKind;
  definition: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export async function createAudience(
  tx: Tx,
  input: {
    tenantId: string;
    name: string;
    kind: AudienceKind;
    definition?: AudienceDefinition | undefined;
  },
): Promise<AudienceRow> {
  if (input.kind !== 'static') {
    if (!input.definition) {
      throw new CampaignError('definition_required', 400, `a ${input.kind} audience needs a definition`);
    }
    assertDefinitionShape(input.kind, input.definition);
    if (isDiscoveryDefinition(input.definition)) await checkDiscoveryDefinition(tx, input.definition);
  }

  let row: AudienceRow | undefined;
  try {
    [row] = await tx.savepoint(
      (sp) => sp<AudienceRow[]>`
        insert into audiences (tenant_id, name, kind, definition)
        values (${input.tenantId}, ${input.name}, ${input.kind},
                ${sp.json((input.kind === 'static' ? {} : input.definition) as never)})
        returning *
      `,
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new CampaignError('audience_exists', 409, `an audience named ${input.name} already exists`);
    }
    throw err;
  }
  if (!row) throw new Error('createAudience wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'audience.saved',
    subjectType: 'audience',
    subjectId: row.id,
    payload: { name: row.name, kind: row.kind, created: true },
  });
  return row;
}

/** A search audience takes a search definition, a discovery one a discovery definition. */
function assertDefinitionShape(kind: AudienceKind, definition: AudienceDefinition): void {
  const shape = isDiscoveryDefinition(definition) ? 'discovery' : 'search';
  if (kind === 'static') {
    throw new CampaignError('not_search', 400, 'only a search or discovery audience has a definition');
  }
  if (shape !== kind) {
    throw new CampaignError('invalid_definition', 400, `a ${kind} audience takes a ${kind} definition`);
  }
}

/**
 * Every search a discovery audience draws on must be the requester's own and
 * finished. A search that is missing or another requester's gets the same
 * answer, so one requester learns nothing about another's.
 */
async function checkDiscoveryDefinition(tx: Tx, definition: DiscoveryDefinition): Promise<void> {
  const ids = [...new Set(definition.searchIds)];
  if (ids.length < 1 || ids.length > MAX_AUDIENCE_SEARCHES) {
    throw new CampaignError(
      'invalid_definition',
      400,
      `a discovery audience draws on 1 to ${MAX_AUDIENCE_SEARCHES} searches`,
    );
  }
  const statuses = await ownSearchStatuses(tx, { requesterRef: definition.requesterRef, ids });
  const missing = ids.filter((id) => !statuses.has(id));
  if (missing.length) {
    throw new CampaignError(
      'search_not_found',
      400,
      'some searches do not exist or belong to another requester',
      { ids: missing },
    );
  }
  const notDone = ids.filter((id) => statuses.get(id) !== 'done');
  if (notDone.length) {
    throw new CampaignError('search_not_done', 400, 'some searches have not finished', { ids: notDone });
  }
}

export async function getAudience(tx: Tx, id: string): Promise<AudienceRow | undefined> {
  const [row] = await tx<AudienceRow[]>`select * from audiences where id = ${id}`;
  return row;
}

export async function listAudiences(tx: Tx): Promise<(AudienceRow & { members: number | null })[]> {
  return tx<(AudienceRow & { members: number | null })[]>`
    select a.*,
           case when a.kind = 'static'
                then (select count(*)::int from audience_members m where m.audience_id = a.id)
           end as members
    from audiences a
    order by a.created_at desc, a.id desc
  `;
}

export async function memberCount(tx: Tx, audienceId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from audience_members where audience_id = ${audienceId}
  `;
  return row?.n ?? 0;
}

export async function patchAudience(
  tx: Tx,
  input: { tenantId: string; id: string; name?: string | undefined; definition?: AudienceDefinition | undefined },
): Promise<AudienceRow | undefined> {
  const existing = await getAudience(tx, input.id);
  if (!existing) return undefined;
  if (input.definition) {
    assertDefinitionShape(existing.kind, input.definition);
    if (isDiscoveryDefinition(input.definition)) await checkDiscoveryDefinition(tx, input.definition);
  }

  let row: AudienceRow | undefined;
  try {
    [row] = await tx.savepoint(
      (sp) => sp<AudienceRow[]>`
        update audiences set
          name       = ${input.name ?? existing.name},
          definition = ${sp.json((input.definition ?? existing.definition) as never)},
          updated_at = now()
        where id = ${input.id}
        returning *
      `,
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new CampaignError('audience_exists', 409, `an audience named ${input.name} already exists`);
    }
    throw err;
  }

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'audience.saved',
    subjectType: 'audience',
    subjectId: input.id,
    payload: { name: row!.name, kind: row!.kind, created: false },
  });
  return row;
}

/** An audience a campaign points at stays: the campaign's history refers to it. */
export async function deleteAudience(tx: Tx, input: { tenantId: string; id: string }): Promise<boolean> {
  const [used] = await tx<{ id: string }[]>`
    select id from campaigns where audience_id = ${input.id} limit 1
  `;
  if (used) {
    throw new CampaignError('audience_in_use', 409, 'a campaign uses this audience');
  }

  const deleted = await tx`delete from audiences where id = ${input.id}`;
  if (deleted.count === 0) return false;

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'audience.deleted',
    subjectType: 'audience',
    subjectId: input.id,
  });
  return true;
}

async function staticAudience(tx: Tx, id: string): Promise<AudienceRow> {
  const audience = await getAudience(tx, id);
  if (!audience) throw new CampaignError('not_found', 404, 'audience not found');
  if (audience.kind !== 'static') {
    throw new CampaignError('not_static', 400, 'members belong to static audiences only');
  }
  return audience;
}

/**
 * Add stored contacts by id. Ids this tenant does not have are reported, not
 * added; a hidden contact counts as one the tenant does not have.
 */
export async function addMembers(
  tx: Tx,
  input: { audienceId: string; contactIds: string[] },
): Promise<{ added: number; unknown: string[] }> {
  await staticAudience(tx, input.audienceId);

  const known = await tx<{ id: string }[]>`
    select id from contacts where id = any(${input.contactIds}::uuid[]) and not hidden
  `;
  const knownIds = new Set(known.map((k) => k.id));

  const inserted = knownIds.size
    ? await tx`
        insert into audience_members (audience_id, contact_id)
        select ${input.audienceId}, unnest(${[...knownIds]}::uuid[])
        on conflict do nothing
      `
    : { count: 0 };

  return { added: inserted.count, unknown: input.contactIds.filter((id) => !knownIds.has(id)) };
}

/**
 * Add members by address. Each row is upserted as a contact first, so an
 * address nobody has stored yet becomes a contact, with no consent.
 */
export async function addMembersByAddress(
  tx: Tx,
  input: { tenantId: string; audienceId: string; rows: ContactFields[] },
): Promise<{ added: number; contactsCreated: number; rejected: { row: number; reason: string }[] }> {
  await staticAudience(tx, input.audienceId);

  const ids: string[] = [];
  let contactsCreated = 0;
  const rejected: { row: number; reason: string }[] = [];

  for (const [index, fields] of input.rows.entries()) {
    try {
      const { contact, created } = await tx.savepoint((sp) =>
        upsertContact(sp, { tenantId: input.tenantId, ...fields }),
      );
      ids.push(contact.id);
      if (created) contactsCreated += 1;
    } catch (err) {
      const reason = err instanceof CampaignError ? err.code : (err as Error).message;
      rejected.push({ row: index + 2, reason });
    }
  }

  const { added } = await addMembers(tx, { audienceId: input.audienceId, contactIds: ids });
  return { added, contactsCreated, rejected };
}

export async function removeMember(
  tx: Tx,
  input: { audienceId: string; contactId: string },
): Promise<boolean> {
  await staticAudience(tx, input.audienceId);
  const deleted = await tx`
    delete from audience_members
    where audience_id = ${input.audienceId} and contact_id = ${input.contactId}
  `;
  return deleted.count > 0;
}

// ---------------------------------------------------------------------------
// Discovery audiences: found buyers
// ---------------------------------------------------------------------------

export type DiscoveryBuyer = {
  company: { id: string; name: string };
  city: string | null;
  country: string | null;
  /** The best fit any of the searches gave it. */
  fit: DiscoveryFit;
  /** The best rank any of the searches gave it. */
  rank: number;
  /** The searches it was found in, among those asked for. */
  searchIds: string[];
  /** Whether the registry holds a phone or an email for it. Never which. */
  reachable: boolean;
};

export type DiscoveryCounts = { companies: number; reachable: number; unreachable: number };

export type DiscoveryPreview = DiscoveryCounts & { buyers: DiscoveryBuyer[] };

/**
 * The buyers a definition means right now, best rank first, with nothing
 * written: the union of the searches' results in `fit`, a merged-away
 * company counted as its survivor and once only, minus the unticked and
 * those now on the marketplace. For the portal while the supplier is picking
 * searches, and for listing a saved audience's buyers.
 */
export async function previewDiscovery(tx: Tx, definition: DiscoveryDefinition): Promise<DiscoveryPreview> {
  await checkDiscoveryDefinition(tx, definition);
  const { buyers } = await buyersOf(tx, definition);
  return { ...countsOf(buyers), buyers };
}

function countsOf(buyers: DiscoveryBuyer[]): DiscoveryCounts {
  const reachable = buyers.filter((b) => b.reachable).length;
  return { companies: buyers.length, reachable, unreachable: buyers.length - reachable };
}

type Addresses = Map<string, { phones: string[]; emails: string[] }>;

async function buyersOf(
  tx: Tx,
  definition: DiscoveryDefinition,
): Promise<{ buyers: DiscoveryBuyer[]; addresses: Addresses }> {
  const rows = await rankedCompanies(tx, { searchIds: definition.searchIds, fit: definition.fit });
  const excluded = new Set(definition.excludeCompanyIds ?? []);

  const byCompany = new Map<string, DiscoveryBuyer>();
  for (const row of rows) {
    if (row.onPlatform || excluded.has(row.companyId)) continue;
    const have = byCompany.get(row.companyId);
    if (!have) {
      byCompany.set(row.companyId, {
        company: { id: row.companyId, name: row.name },
        city: row.city,
        country: row.country,
        fit: row.fit,
        rank: row.rank,
        searchIds: [row.searchId],
        reachable: false,
      });
      continue;
    }
    have.rank = Math.min(have.rank, row.rank);
    if (row.fit === 'strong') have.fit = 'strong';
    if (!have.searchIds.includes(row.searchId)) have.searchIds.push(row.searchId);
  }

  const addresses = await contactIdentifiers(tx, [...byCompany.keys()]);
  for (const buyer of byCompany.values()) {
    const held = addresses.get(buyer.company.id);
    buyer.reachable = Boolean(held && (held.phones.length || held.emails.length));
  }

  const buyers = [...byCompany.values()].sort(
    (a, b) =>
      a.rank - b.rank ||
      a.company.name.localeCompare(b.company.name) ||
      a.company.id.localeCompare(b.company.id),
  );
  return { buyers, addresses };
}

/**
 * The audience itself: one tenant contact per reachable buyer, made here when
 * the tenant has none for any of the company's addresses. A contact made here
 * is hidden, carries the company's longest-known phone and email, and is
 * named after the company. A normal contact the tenant already holds for one
 * of those addresses is used unchanged. Either way one company is one
 * recipient, however many numbers it has.
 */
export async function resolveDiscovery(
  tx: Tx,
  input: { tenantId: string; audienceId: string; definition: DiscoveryDefinition },
): Promise<DiscoveryCounts & { contactIds: string[]; created: number }> {
  const { buyers, addresses } = await buyersOf(tx, input.definition);
  const reachable = buyers.filter((b) => b.reachable);

  const phones = reachable.flatMap((b) => addresses.get(b.company.id)?.phones ?? []);
  const emails = reachable.flatMap((b) => addresses.get(b.company.id)?.emails ?? []);
  // Visible contacts first, then the oldest: the one a buyer gets when the
  // tenant holds several of its addresses.
  const held = await tx<ContactRow[]>`
    select * from contacts
    where tenant_id = ${input.tenantId}
      and (phone = any(${phones}::text[]) or email = any(${emails}::text[]))
    order by hidden, created_at, id
  `;
  const byAddress = new Map<string, ContactRow>();
  for (const contact of held) {
    for (const address of [contact.phone, contact.email]) {
      if (address && !byAddress.has(address)) byAddress.set(address, contact);
    }
  }
  const pick = (candidates: ContactRow[]): ContactRow | undefined =>
    candidates.sort(
      (a, b) =>
        Number(a.hidden) - Number(b.hidden) ||
        a.created_at.getTime() - b.created_at.getTime() ||
        a.id.localeCompare(b.id),
    )[0];

  const contactIds = new Set<string>();
  let created = 0;
  for (const buyer of reachable) {
    const own = addresses.get(buyer.company.id)!;
    const candidates = [...own.phones, ...own.emails].flatMap((a) => byAddress.get(a) ?? []);
    let contact = pick([...new Set(candidates)]);

    if (!contact) {
      contact = await insertHidden(tx, input.tenantId, buyer, own);
      created += 1;
      for (const address of [contact.phone, contact.email]) if (address) byAddress.set(address, contact);
    } else if (contact.hidden) {
      await fillHidden(tx, contact, buyer, own);
    }
    contactIds.add(contact.id);
  }

  const counts = countsOf(buyers);
  await emit(tx, {
    tenantId: input.tenantId,
    type: 'audience.resolved',
    subjectType: 'audience',
    subjectId: input.audienceId,
    payload: { ...counts, contacts: contactIds.size, created },
  });
  return { ...counts, contactIds: [...contactIds].sort(), created };
}

async function insertHidden(
  tx: Tx,
  tenantId: string,
  buyer: DiscoveryBuyer,
  own: { phones: string[]; emails: string[] },
): Promise<ContactRow> {
  const phone = own.phones[0] ?? null;
  const email = own.emails[0] ?? null;
  try {
    const [row] = await tx.savepoint(
      (sp) => sp<ContactRow[]>`
        insert into contacts (tenant_id, phone, email, company_id, name, hidden)
        values (${tenantId}, ${phone}, ${email}, ${buyer.company.id}, ${buyer.company.name}, true)
        returning *
      `,
    );
    return row!;
  } catch (err) {
    // Two resolutions of one audience at once (a preview during a run):
    // the other one wrote it first, and that row is the one to use.
    if ((err as { code?: string }).code !== '23505') throw err;
    const [row] = await tx<ContactRow[]>`
      select * from contacts
      where tenant_id = ${tenantId} and (phone = ${phone} or email = ${email})
      order by hidden, created_at, id
      limit 1
    `;
    if (!row) throw err;
    return row;
  }
}

/** A hidden contact learns an address the company has since gained; a normal one is never touched. */
async function fillHidden(
  tx: Tx,
  contact: ContactRow,
  buyer: DiscoveryBuyer,
  own: { phones: string[]; emails: string[] },
): Promise<void> {
  const phone = contact.phone ?? own.phones[0] ?? null;
  const email = contact.email ?? own.emails[0] ?? null;
  if (phone === contact.phone && email === contact.email && contact.company_id) return;
  try {
    await tx.savepoint(
      (sp) => sp`
        update contacts set
          phone = ${phone}, email = ${email},
          company_id = coalesce(company_id, ${buyer.company.id}),
          name = coalesce(name, ${buyer.company.name}),
          updated_at = now()
        where id = ${contact.id} and hidden
      `,
    );
  } catch (err) {
    // The new address belongs to another contact already; this one keeps what it had.
    if ((err as { code?: string }).code !== '23505') throw err;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Who this audience means right now, as contact ids in id order. The order is
 * the point: a run that expands the same audience twice gets the same list.
 *
 * A search audience runs the finder, takes the companies it returns, and then
 * this tenant's contacts linked to them. A discovery audience is the buyers
 * its searches found, as one contact each (see resolveDiscovery). Hidden
 * contacts belong to discovery audiences only.
 */
export async function resolveAudience(
  tx: Tx,
  audience: AudienceRow,
  input: { limit: number },
): Promise<string[]> {
  return (await expand(tx, audience, input.limit)).ids;
}

async function expand(
  tx: Tx,
  audience: AudienceRow,
  limit: number,
): Promise<{ ids: string[]; discovery?: DiscoveryCounts }> {
  if (audience.kind === 'static') {
    const rows = await tx<{ contact_id: string }[]>`
      select contact_id from audience_members
      where audience_id = ${audience.id}
      order by contact_id
      limit ${limit}
    `;
    return { ids: rows.map((r) => r.contact_id) };
  }

  if (audience.kind === 'discovery') {
    const resolved = await resolveDiscovery(tx, {
      tenantId: audience.tenant_id,
      audienceId: audience.id,
      definition: audience.definition as unknown as DiscoveryDefinition,
    });
    const { contactIds, created: _created, ...discovery } = resolved;
    return { ids: contactIds.slice(0, limit), discovery };
  }

  const definition = audience.definition as SearchDefinition;
  const companies = await findCompanyIds(tx, {
    tenantId: audience.tenant_id,
    query: {
      ...definition.finderQuery,
      limit: Math.min(definition.finderQuery.limit ?? MAX_SEARCH_COMPANIES, MAX_SEARCH_COMPANIES),
    },
  });
  if (companies.length === 0) return { ids: [] };

  const filter = definition.contactFilter ?? {};
  const channels = filter.hasChannel ?? [];
  const wantsPhone = channels.includes('sms') || channels.includes('whatsapp');
  const wantsEmail = channels.includes('email');
  const wantsTelegram = channels.includes('telegram');

  const rows = await tx<{ id: string }[]>`
    select id from contacts
    where tenant_id = ${audience.tenant_id}
      and not hidden
      and company_id = any(${companies}::uuid[])
      ${filter.companyIds?.length ? tx`and company_id = any(${filter.companyIds}::uuid[])` : tx``}
      ${filter.tags?.length ? tx`and attributes -> 'tags' ?| ${filter.tags}::text[]` : tx``}
      ${
        channels.length
          ? tx`and (
              (${wantsPhone} and phone is not null)
              or (${wantsEmail} and email is not null)
              or (${wantsTelegram} and telegram is not null)
            )`
          : tx``
      }
    order by id
    limit ${limit}
  `;
  return { ids: rows.map((r) => r.id) };
}

export type PreviewContact = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  company: { id: string; name: string } | null;
  allowed: boolean;
  channel: Channel | null;
  reason: string | null;
};

export type Preview = {
  total: number;
  sampled: number;
  sendable: number;
  contacts: PreviewContact[];
  /** For a discovery audience: the buyers behind the contacts. */
  companies?: number;
  reachable?: number;
  unreachable?: number;
};

/** The purpose a preview judges by when the caller names none: what a campaign on this audience would send. */
export function defaultPurpose(kind: AudienceKind): Purpose {
  return kind === 'discovery' ? 'outreach' : 'marketing';
}

/**
 * The honest answer to "who will actually get this": the first `limit`
 * contacts the audience resolves to, each with the verdict send() would give
 * it for this purpose, and the size of the whole audience. A hidden contact
 * shows its company and no address.
 */
export async function previewAudience(
  tx: Tx,
  input: {
    tenantId: string;
    audienceId: string;
    limit: number;
    purpose?: Purpose | undefined;
    channel?: Channel | undefined;
    at?: Date | undefined;
  },
): Promise<Preview> {
  const audience = await getAudience(tx, input.audienceId);
  if (!audience) throw new CampaignError('not_found', 404, 'audience not found');
  const purpose = input.purpose ?? defaultPurpose(audience.kind);

  const { ids, discovery } = await expand(tx, audience, MAX_AUDIENCE);
  const rows = await contactsWithCompany(tx, ids.slice(0, input.limit));

  const contacts: PreviewContact[] = [];
  for (const contact of rows) {
    const verdict = await preflight(tx, {
      tenantId: input.tenantId,
      contact: contactInput(contact),
      purpose,
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.at ? { at: input.at } : {}),
    });
    contacts.push({
      id: contact.id,
      ...presentContact(contact),
      allowed: verdict.allowed,
      channel: verdict.allowed ? verdict.channel : null,
      reason: verdict.allowed ? null : verdict.reason,
    });
  }

  return {
    total: ids.length,
    sampled: contacts.length,
    sendable: contacts.filter((c) => c.allowed).length,
    contacts,
    ...(discovery ?? {}),
  };
}

/**
 * Is anyone in this audience sendable? Stops at the first who is, so an
 * audience with somebody reachable near the front answers at once.
 *
 * Someone held back only by a sending window counts: a campaign defers them
 * until the window opens rather than dropping them.
 */
export async function anySendable(
  tx: Tx,
  input: {
    tenantId: string;
    audience: AudienceRow;
    purpose: Purpose;
    channel?: Channel | undefined;
    at?: Date | undefined;
  },
): Promise<boolean> {
  if ((await configuredChannels(tx, input.tenantId)).length === 0) return false;

  const ids = await resolveAudience(tx, input.audience, { limit: MAX_AUDIENCE });
  for (let start = 0; start < ids.length; start += 500) {
    const rows = await tx<ContactRow[]>`
      select * from contacts where id = any(${ids.slice(start, start + 500)}::uuid[]) order by id
    `;
    for (const contact of rows) {
      const verdict = await preflight(tx, {
        tenantId: input.tenantId,
        contact: contactInput(contact),
        purpose: input.purpose,
        ...(input.channel ? { channel: input.channel } : {}),
        ...(input.at ? { at: input.at } : {}),
      });
      if (verdict.allowed || verdict.window) return true;
    }
  }
  return false;
}
