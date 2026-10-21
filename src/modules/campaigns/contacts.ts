import { withTenant, type Tx } from '../../db/client.js';
import { record } from '../../spine/consent/index.js';
import {
  CHANNELS,
  InvalidAddressError,
  PURPOSES,
  normalize,
  type Channel,
  type Purpose,
} from '../../spine/contacts/normalize.js';
import { emit } from '../../spine/events/index.js';
import { parseCsv, splitList } from '../../spine/registry/csv.js';
import { findByIdentifier, normalizeIdentifiers, resolve } from '../../spine/registry/index.js';
import { CampaignError } from './errors.js';

export type ContactRow = {
  id: string;
  tenant_id: string;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  company_id: string | null;
  name: string | null;
  locale: string | null;
  attributes: Record<string, unknown>;
  /**
   * An outreach contact the engine made for a found buyer (a discovery
   * audience). Nothing about it says which address the engine sends to: it
   * is not listed, a read by id answers as unknown, and wherever it appears
   * its addresses are null. (The search results list every address the
   * registry holds for the company, brief 27.)
   * It becomes a normal contact when the tenant stores the same address.
   */
  hidden: boolean;
  created_at: Date;
  updated_at: Date;
};

/** A contact with its company's name, for the views that show one. */
export type ContactWithCompany = ContactRow & { company_name: string | null };

/**
 * A contact as the tenant may see it. A hidden one shows its company and no
 * address; any other shows its addresses and, when it has one, its company.
 */
export function presentContact(contact: ContactWithCompany): {
  name: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  company: { id: string; name: string } | null;
} {
  return {
    name: contact.name,
    phone: contact.hidden ? null : contact.phone,
    email: contact.hidden ? null : contact.email,
    telegram: contact.hidden ? null : contact.telegram,
    company:
      contact.company_id ? { id: contact.company_id, name: contact.company_name ?? '' } : null,
  };
}

/** The contacts with these ids, in id order, each with its company's name. */
export async function contactsWithCompany(tx: Tx, ids: string[]): Promise<ContactWithCompany[]> {
  if (ids.length === 0) return [];
  return tx<ContactWithCompany[]>`
    select c.*, co.name as company_name
    from contacts c
    left join companies co on co.id = c.company_id
    where c.id = any(${ids}::uuid[])
    order by c.id
  `;
}

/**
 * The hidden contact holding this address for the tenant, if there is one:
 * the one case in which a message's address is not shown.
 */
export async function hiddenContactByAddress(
  tx: Tx,
  tenantId: string,
  address: string,
): Promise<ContactRow | undefined> {
  const [row] = await tx<ContactRow[]>`
    select * from contacts
    where tenant_id = ${tenantId} and hidden
      and (phone = ${address} or email = ${address} or telegram = ${address})
    limit 1
  `;
  return row;
}

export type ContactFields = {
  phone?: string | undefined;
  email?: string | undefined;
  telegram?: string | undefined;
  companyId?: string | undefined;
  name?: string | undefined;
  locale?: string | undefined;
  attributes?: Record<string, unknown> | undefined;
  /** For a national phone number like 0501234567. */
  defaultCountry?: string | undefined;
};

/** The addresses in the one form they are stored and compared in. */
function normalizeAddresses(input: ContactFields): {
  phone: string | null;
  email: string | null;
  telegram: string | null;
} {
  const country = input.defaultCountry ? { defaultCountry: input.defaultCountry } : {};
  return {
    phone: input.phone ? normalize({ channel: 'sms', address: input.phone, ...country }).address : null,
    email: input.email ? normalize({ channel: 'email', address: input.email }).address : null,
    telegram: input.telegram
      ? normalize({ channel: 'telegram', address: input.telegram }).address
      : null,
  };
}

/**
 * Store a contact, or fill in the one that already has any of these addresses.
 *
 * Never merges two stored contacts: when the addresses given belong to two
 * different ones, that is a question for whoever is calling, so the error
 * names both and nothing is written.
 */
export async function upsertContact(
  tx: Tx,
  input: ContactFields & { tenantId: string },
): Promise<{ contact: ContactRow; created: boolean }> {
  const addresses = normalizeAddresses(input);
  if (!addresses.phone && !addresses.email && !addresses.telegram) {
    throw new CampaignError('address_missing', 400, 'a contact needs a phone, email or telegram');
  }

  const matches = await tx<ContactRow[]>`
    select * from contacts
    where tenant_id = ${input.tenantId}
      and (phone = ${addresses.phone} or email = ${addresses.email}
           or telegram = ${addresses.telegram})
    order by created_at
  `;
  if (matches.length > 1) {
    throw new CampaignError(
      'contact_ambiguous',
      409,
      'these addresses belong to more than one contact',
      { contactIds: matches.map((m) => m.id) },
    );
  }

  const companyId = await companyFor(tx, input.companyId, addresses, matches[0]?.company_id);
  const existing = matches[0];

  // The tenant storing an address the engine had hidden brings that contact
  // into the open: the tenant holds the address now.
  const [row] = existing
    ? await tx<ContactRow[]>`
        update contacts set
          phone      = coalesce(${addresses.phone}, phone),
          email      = coalesce(${addresses.email}, email),
          telegram   = coalesce(${addresses.telegram}, telegram),
          company_id = ${companyId},
          name       = coalesce(${input.name ?? null}, name),
          locale     = coalesce(${input.locale ?? null}, locale),
          attributes = attributes || ${tx.json((input.attributes ?? {}) as never)},
          hidden     = false,
          updated_at = now()
        where id = ${existing.id}
        returning *
      `
    : await tx<ContactRow[]>`
        insert into contacts (tenant_id, phone, email, telegram, company_id, name, locale, attributes)
        values (${input.tenantId}, ${addresses.phone}, ${addresses.email}, ${addresses.telegram},
                ${companyId}, ${input.name ?? null}, ${input.locale ?? null},
                ${tx.json((input.attributes ?? {}) as never)})
        returning *
      `;
  if (!row) throw new Error('upsertContact wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'contact.upserted',
    subjectType: 'contact',
    subjectId: row.id,
    payload: { created: !existing, companyId: row.company_id },
  });

  return { contact: row, created: !existing };
}

/**
 * The company a contact belongs to: the one the caller named, else the one it
 * already had, else whichever company in the registry owns its phone or email
 * (the same lookup send() makes).
 */
async function companyFor(
  tx: Tx,
  given: string | undefined,
  addresses: { phone: string | null; email: string | null },
  current: string | null | undefined,
): Promise<string | null> {
  if (given) {
    const company = await resolve(tx, given);
    if (!company) throw new CampaignError('company_not_found', 404, `no company ${given}`);
    return company.id;
  }
  if (current) return current;
  if (addresses.phone) {
    const company = await findByIdentifier(tx, 'phone', addresses.phone);
    if (company) return company.id;
  }
  if (addresses.email) {
    const company = await findByIdentifier(tx, 'email', addresses.email);
    if (company) return company.id;
  }
  return null;
}

/** A contact by id. A hidden one answers as unknown. */
export async function getContact(tx: Tx, id: string): Promise<ContactRow | undefined> {
  const [row] = await tx<ContactRow[]>`select * from contacts where id = ${id} and not hidden`;
  return row;
}

/** Newest first, cursor by the last row's id. RLS scopes the rows to the tenant; hidden ones are left out. */
export async function listContacts(
  tx: Tx,
  input: { q?: string | undefined; companyId?: string | undefined; limit: number; cursor?: string | undefined },
): Promise<ContactRow[]> {
  const like = input.q ? `%${input.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  return tx<ContactRow[]>`
    select * from contacts
    where not hidden
      ${like ? tx`and (name ilike ${like} or phone ilike ${like} or email ilike ${like} or telegram ilike ${like})` : tx``}
      ${input.companyId ? tx`and company_id = ${input.companyId}` : tx``}
      ${input.cursor ? tx`and (created_at, id) < (select created_at, id from contacts where id = ${input.cursor})` : tx``}
    order by created_at desc, id desc
    limit ${input.limit}
  `;
}

/** Change what the caller names. Attributes merge; an address may not collide with another contact's. */
export async function patchContact(
  tx: Tx,
  input: ContactFields & { tenantId: string; id: string },
): Promise<ContactRow | undefined> {
  const existing = await getContact(tx, input.id);
  if (!existing) return undefined;

  const addresses = normalizeAddresses(input);
  const companyId = input.companyId
    ? await companyFor(tx, input.companyId, addresses, null)
    : existing.company_id;

  let row: ContactRow | undefined;
  try {
    [row] = await tx.savepoint(
      (sp) => sp<ContactRow[]>`
        update contacts set
          phone      = coalesce(${addresses.phone}, phone),
          email      = coalesce(${addresses.email}, email),
          telegram   = coalesce(${addresses.telegram}, telegram),
          company_id = ${companyId},
          name       = coalesce(${input.name ?? null}, name),
          locale     = coalesce(${input.locale ?? null}, locale),
          attributes = attributes || ${sp.json((input.attributes ?? {}) as never)},
          updated_at = now()
        where id = ${input.id}
        returning *
      `,
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new CampaignError('contact_conflict', 409, 'another contact already has that address');
    }
    throw err;
  }
  if (!row) return undefined;

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'contact.upserted',
    subjectType: 'contact',
    subjectId: row.id,
    payload: { created: false, companyId: row.company_id },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const CONTACT_IMPORT_HEADER = [
  'phone',
  'email',
  'telegram',
  'name',
  'company_cr',
  'attributes',
  'consent_channels',
  'consent_purpose',
  'consent_source',
  'consent_date',
] as const;

export const MAX_CONTACT_IMPORT_ROWS = 20_000;
const IMPORT_BATCH = 500;

type ImportRow = Record<(typeof CONTACT_IMPORT_HEADER)[number], string>;

export type ImportSummary = {
  rows: number;
  contactsCreated: number;
  contactsUpdated: number;
  consentRecorded: number;
  rejected: { row: number; reason: string }[];
};

/** Rows keyed by the fixed header, which must match exactly. */
export function readContactImport(text: string): ImportRow[] {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw new CampaignError('invalid_csv', 400, 'the file is empty');

  const given = header.map((h) => h.trim().toLowerCase()).join(',');
  const expected = CONTACT_IMPORT_HEADER.join(',');
  if (given !== expected) {
    throw new CampaignError('invalid_csv', 400, `header must be exactly: ${expected} (got: ${given})`);
  }

  return rows.map((row) => {
    const record = {} as ImportRow;
    CONTACT_IMPORT_HEADER.forEach((key, i) => {
      record[key] = (row[i] ?? '').trim();
    });
    return record;
  });
}

type Planned = {
  fields: ContactFields;
  companyCr: string | null;
  consent: { channels: Channel[]; purpose: Purpose; source: string; date: Date } | null;
};

/**
 * What a row asks for, or why it cannot be imported. Pure: every check that
 * does not need the database happens here, before any transaction opens.
 */
function planRow(row: ImportRow, defaultCountry: string | undefined): Planned | string {
  if (!row.phone && !row.email && !row.telegram) return 'a contact needs a phone, email or telegram';

  let attributes: Record<string, unknown> | undefined;
  if (row.attributes) {
    try {
      const parsed = JSON.parse(row.attributes) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'attributes must be a JSON object';
      }
      attributes = parsed as Record<string, unknown>;
    } catch {
      return 'attributes is not valid JSON';
    }
  }

  const fields: ContactFields = {
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.email ? { email: row.email } : {}),
    ...(row.telegram ? { telegram: row.telegram } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(attributes ? { attributes } : {}),
    ...(defaultCountry ? { defaultCountry } : {}),
  };

  try {
    normalizeAddresses(fields);
  } catch (err) {
    if (err instanceof InvalidAddressError) return err.message;
    throw err;
  }

  // Consent is all four columns or none. A row with an address and no
  // evidence imports the contact and records nothing: consent is never
  // inferred from having someone's number.
  const consentGiven = [row.consent_channels, row.consent_purpose, row.consent_source, row.consent_date];
  if (consentGiven.every((v) => !v)) return { fields, companyCr: row.company_cr || null, consent: null };
  if (consentGiven.some((v) => !v)) {
    return 'consent needs all of consent_channels, consent_purpose, consent_source and consent_date';
  }

  const channels = splitList(row.consent_channels);
  const unknown = channels.filter((c) => !CHANNELS.includes(c as Channel));
  if (unknown.length) return `unknown consent channel: ${unknown.join(', ')}`;
  for (const channel of channels as Channel[]) {
    const address = channel === 'email' ? row.email : channel === 'telegram' ? row.telegram : row.phone;
    if (!address) return `consent for ${channel} but no address for it`;
  }

  if (!PURPOSES.includes(row.consent_purpose as Purpose)) {
    return `consent_purpose must be one of ${PURPOSES.join(', ')}`;
  }

  const date = new Date(row.consent_date);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(row.consent_date)) {
    return 'consent_date must be an ISO date';
  }
  if (date.getTime() > Date.now()) return 'consent_date is in the future';

  return {
    fields,
    companyCr: row.company_cr || null,
    consent: {
      channels: channels as Channel[],
      purpose: row.consent_purpose as Purpose,
      source: row.consent_source,
      date,
    },
  };
}

/**
 * Import a file of contacts, with consent where the file carries the evidence.
 *
 * Batches of 500 rows, each in its own transaction, and each row in its own
 * savepoint inside it: a bad row is rejected on its own, and a batch that
 * fails outright cannot take the rest of the file with it.
 */
export async function importContacts(input: {
  tenantId: string;
  csv: string;
  defaultCountry?: string | undefined;
}): Promise<ImportSummary> {
  const rows = readContactImport(input.csv);
  if (rows.length > MAX_CONTACT_IMPORT_ROWS) {
    throw new CampaignError('too_many_rows', 400, `at most ${MAX_CONTACT_IMPORT_ROWS} rows per import`);
  }

  const summary: ImportSummary = {
    rows: rows.length,
    contactsCreated: 0,
    contactsUpdated: 0,
    consentRecorded: 0,
    rejected: [],
  };

  for (let start = 0; start < rows.length; start += IMPORT_BATCH) {
    const batch = rows.slice(start, start + IMPORT_BATCH);

    await withTenant(input.tenantId, async (tx) => {
      for (const [offset, row] of batch.entries()) {
        // Row 1 is the header, so the first data row is row 2 in the file.
        const lineNumber = start + offset + 2;
        const plan = planRow(row, input.defaultCountry);
        if (typeof plan === 'string') {
          summary.rejected.push({ row: lineNumber, reason: plan });
          continue;
        }

        try {
          const outcome = await tx.savepoint((sp) => importOne(sp, input.tenantId, plan));
          if (outcome.created) summary.contactsCreated += 1;
          else summary.contactsUpdated += 1;
          summary.consentRecorded += outcome.consentRecorded;
        } catch (err) {
          if (err instanceof CampaignError || err instanceof InvalidAddressError) {
            summary.rejected.push({
              row: lineNumber,
              reason: err instanceof CampaignError ? err.code : err.message,
            });
            continue;
          }
          throw err;
        }
      }
    });
  }

  return summary;
}

async function importOne(
  tx: Tx,
  tenantId: string,
  plan: Planned,
): Promise<{ created: boolean; consentRecorded: number }> {
  let companyId: string | undefined;
  if (plan.companyCr) {
    const cr = normalizeIdentifiers([{ type: 'cr', value: plan.companyCr }]).identifiers[0];
    const company = cr ? await findByIdentifier(tx, 'cr', cr.value) : undefined;
    companyId = company?.id;
  }

  const { contact, created } = await upsertContact(tx, {
    tenantId,
    ...plan.fields,
    ...(companyId ? { companyId } : {}),
  });

  let consentRecorded = 0;
  if (plan.consent) {
    for (const channel of plan.consent.channels) {
      const address =
        channel === 'email' ? contact.email : channel === 'telegram' ? contact.telegram : contact.phone;
      await record(tx, {
        tenantId,
        channel,
        address: address!,
        purpose: plan.consent.purpose,
        status: 'granted',
        source: plan.consent.source,
        recordedAt: plan.consent.date,
      });
      consentRecorded += 1;
    }
  }

  return { created, consentRecorded };
}

/** The address a contact has for a channel. A phone serves SMS and WhatsApp. */
export function contactInput(contact: ContactRow): {
  phone?: string;
  email?: string;
  telegram?: string;
} {
  return {
    ...(contact.phone ? { phone: contact.phone } : {}),
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.telegram ? { telegram: contact.telegram } : {}),
  };
}
