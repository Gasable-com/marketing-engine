import { asOwner, type Tx } from "../../db/client.js";
import { emit } from "../events/index.js";
import {
  isStrong,
  normalizeIdentifiers,
  type Identifier,
  type IdentifierType,
  type RawIdentifier,
} from "./identifiers.js";
import { companyLookup, type CompanyFacts } from "./lookup/index.js";
import { normalizeName } from "./names.js";

export * from "./identifiers.js";
export * from "./lookup/index.js";
export { foldText, normalizeName } from "./names.js";

/**
 * How alike two normalised names must be before the registry links them.
 *
 * Saudi trading companies share names to a degree that makes anything looser
 * actively wrong: dozens of real, separate businesses normalise to within a
 * few characters of each other. At 0.90 a link means the names differ only by
 * spelling. Anything below that is a ranking question for discovery's search
 * in step 6, not a statement that two records are the same company.
 */
export const FUZZY_LINK_THRESHOLD = 0.9;

export type CompanyRow = {
  id: string;
  name: string;
  name_normalized: string;
  country: string | null;
  on_platform_ref: string | null;
  on_platform_at: Date | null;
  merged_into: string | null;
  created_at: Date;
  updated_at: Date;
};

export type IdentifierRow = {
  id: string;
  company_id: string;
  type: IdentifierType;
  value: string;
  created_at: Date;
};

export type SourceRow = {
  id: string;
  company_id: string;
  tenant_id: string | null;
  source_type: "rfq" | "import" | "api" | "lookup" | "web" | "maps";
  source_ref: string | null;
  data: Record<string, unknown>;
  recorded_at: Date;
};

export type TenantView = {
  relationship?: "customer" | "supplier" | "prospect" | "other" | undefined;
  tags?: string[] | undefined;
  notes?: string | undefined;
};

export type UpsertInput = {
  name: string;
  country?: string | undefined;
  identifiers: RawIdentifier[];
  source: {
    type: "rfq" | "import" | "api" | "lookup" | "web" | "maps";
    ref?: string | undefined;
    tenantId?: string | undefined;
    data?: Record<string, unknown> | undefined;
  };
  defaultCountry?: string | undefined;
  tenantView?: TenantView | undefined;
  /** Ask the registrar about the CR before storing, when lookup is configured. */
  enrich?: boolean | undefined;
};

export type UpsertResult = {
  company: CompanyRow;
  created: boolean;
  mergedFrom: string[];
};

/** Follow merged_into to the company that survived. */
export async function resolve(
  tx: Tx,
  id: string,
): Promise<CompanyRow | undefined> {
  let [row] = await tx<CompanyRow[]>`select * from companies where id = ${id}`;
  const seen = new Set<string>();
  while (row?.merged_into && !seen.has(row.id)) {
    seen.add(row.id);
    [row] = await tx<
      CompanyRow[]
    >`select * from companies where id = ${row.merged_into}`;
  }
  return row;
}

export async function findByIdentifier(
  tx: Tx,
  type: IdentifierType,
  value: string,
): Promise<CompanyRow | undefined> {
  const [row] = await tx<IdentifierRow[]>`
    select * from company_identifiers where type = ${type} and value = ${value}
  `;
  return row ? resolve(tx, row.company_id) : undefined;
}

export type CompanyDetail = {
  company: CompanyRow;
  identifiers: IdentifierRow[];
  tenantView: Record<string, unknown> | null;
  sources: SourceRow[];
};

/** The company, plus what the calling tenant is allowed to see about it. */
export async function get(
  tx: Tx,
  id: string,
): Promise<CompanyDetail | undefined> {
  const company = await resolve(tx, id);
  if (!company) return undefined;

  const identifiers = await tx<IdentifierRow[]>`
    select * from company_identifiers where company_id = ${company.id} order by type, value
  `;
  // RLS keeps both of these to the calling tenant.
  const [tenantView] = await tx<Record<string, unknown>[]>`
    select * from tenant_company where company_id = ${company.id}
  `;
  const sources = await tx<SourceRow[]>`
    select * from company_sources where company_id = ${company.id} order by recorded_at
  `;

  return { company, identifiers, tenantView: tenantView ?? null, sources };
}

/**
 * The only way into the pool.
 *
 * Strong identifiers decide identity: one match is the company, several means
 * two records were the same company all along and get merged. Only when no
 * strong identifier matches does the name get a say, and then only to link.
 */
export async function upsert(
  tx: Tx,
  input: UpsertInput,
): Promise<UpsertResult> {
  // Ask the registrar first, if asked to. What it says about the name is
  // better than what a spreadsheet says, and it earns its own source row
  // alongside the caller's, so both are on the record.
  const enrichment = input.enrich ? await enrichFromRegistrar(input) : null;
  const name = enrichment?.facts.name ?? input.name;

  const { identifiers, rejected } = normalizeIdentifiers(input.identifiers, {
    ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
  });
  const nameNormalized = normalizeName(name);

  const strong = identifiers.filter((i) => isStrong(i.type));
  let matches = await companiesOwning(tx, strong);

  let company: CompanyRow;
  let created = false;
  let mergedFrom: string[] = [];

  if (matches.length === 1) {
    company = matches[0]!;
  } else if (matches.length > 1) {
    const merged = await merge(tx, matches, input.source.tenantId);
    company = merged.survivor;
    mergedFrom = merged.losers;
  } else {
    const linked = await fuzzyMatch(tx, nameNormalized, input.country ?? null);
    if (linked) {
      company = linked;
    } else {
      company = await insertCompany(
        tx,
        input.name,
        nameNormalized,
        input.country ?? null,
      );
      created = true;
    }
  }

  const conflicts: { type: string; value: string; heldBy: string }[] = [];
  const added: Identifier[] = [];

  for (const identifier of identifiers) {
    const outcome = await attach(tx, company.id, identifier);
    if (outcome.kind === "added") added.push(identifier);
    else if (outcome.kind === "conflict") {
      conflicts.push({ ...identifier, heldBy: outcome.heldBy });
    } else if (outcome.kind === "raced") {
      // A strong identifier appeared under another company between our match
      // and our insert. Re-run identity once with the full picture.
      matches = await companiesOwning(tx, strong);
      if (matches.length > 1) {
        const merged = await merge(tx, matches, input.source.tenantId);
        company = merged.survivor;
        mergedFrom = [...mergedFrom, ...merged.losers];
      } else if (matches[0]) {
        company = matches[0];
      }
    }
  }

  // A later source only fills gaps, except one that came from the registrar,
  // which is better than whatever a spreadsheet said.
  const authoritative = input.source.type === "lookup" || enrichment !== null;
  if (authoritative || !company.country) {
    const [updated] = await tx<CompanyRow[]>`
      update companies set
        name            = ${authoritative ? name : company.name},
        name_normalized = ${authoritative ? nameNormalized : company.name_normalized},
        country         = ${input.country ?? company.country},
        updated_at      = now()
      where id = ${company.id}
      returning *
    `;
    if (updated) company = updated;
  }

  await tx`
    insert into company_sources (company_id, tenant_id, source_type, source_ref, data)
    values (${company.id}, ${input.source.tenantId ?? null}, ${input.source.type},
            ${input.source.ref ?? null},
            ${tx.json({
              ...(input.source.data ?? {}),
              ...(conflicts.length ? { conflicts } : {}),
              ...(rejected.length ? { rejected } : {}),
            } as never)})
  `;

  if (enrichment) {
    await tx`
      insert into company_sources (company_id, tenant_id, source_type, source_ref, data)
      values (${company.id}, ${input.source.tenantId ?? null}, 'lookup', ${enrichment.ref},
              ${tx.json({
                raw: enrichment.facts.raw,
                city: enrichment.facts.city ?? null,
                status: enrichment.facts.status ?? null,
              } as never)})
    `;
  }

  if (input.source.tenantId) {
    await upsertTenantView(
      tx,
      input.source.tenantId,
      company.id,
      input.tenantView,
    );
  }

  if (input.source.tenantId) {
    await emit(tx, {
      tenantId: input.source.tenantId,
      type: created ? "company.created" : "company.updated",
      subjectType: "company",
      subjectId: company.id,
      payload: {
        identifiers: added,
        sourceType: input.source.type,
        ...(mergedFrom.length ? { mergedFrom } : {}),
      },
    });
  }

  return { company, created, mergedFrom };
}

/**
 * Ask the registrar about the CR. Returns null when there is no CR to ask
 * about, nobody to ask, or the registrar does not know: enrichment never fails
 * a write, it only ever adds to one.
 */
async function enrichFromRegistrar(
  input: UpsertInput,
): Promise<{ facts: CompanyFacts; ref: string } | null> {
  const lookup = companyLookup();
  if (!lookup) return null;

  const cr = normalizeIdentifiers(input.identifiers).identifiers.find(
    (i) => i.type === "cr",
  );
  if (!cr) return null;

  const facts = await lookup.byCr(cr.value).catch((err) => {
    console.warn(`registry: lookup for cr ${cr.value} failed`, err);
    return null;
  });
  if (!facts) return null;

  return { facts, ref: `${lookup.provider}:${cr.value}` };
}

/**
 * Distinct live companies owning any of these identifiers, oldest first.
 * One indexed lookup each: the unique key on (type, value) makes them cheap,
 * and an upsert never carries more than a handful of identifiers.
 */
async function companiesOwning(
  tx: Tx,
  identifiers: Identifier[],
): Promise<CompanyRow[]> {
  const found = new Map<string, CompanyRow>();

  for (const identifier of identifiers) {
    const company = await findByIdentifier(
      tx,
      identifier.type,
      identifier.value,
    );
    if (company) found.set(company.id, company);
  }

  return [...found.values()].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime(),
  );
}

/**
 * Two records were the same company all along. The oldest survives; the others
 * keep their rows pointing at it, so the merge is legible and undoable.
 */
async function merge(
  tx: Tx,
  companies: CompanyRow[],
  tenantId: string | undefined,
): Promise<{ survivor: CompanyRow; losers: string[] }> {
  const [survivor, ...losers] = companies;
  const loserIds = losers.map((c) => c.id);

  // A merge rewrites rows that belong to the pool and to other tenants:
  // provenance, message stamps, and every tenant's own view. That is the
  // platform's job, not the calling tenant's, so it runs as the owner.
  await asOwner(tx, async () => {
    for (const loser of losers) {
      await tx`update company_identifiers set company_id = ${survivor!.id} where company_id = ${loser.id}`;
      await tx`update company_sources set company_id = ${survivor!.id} where company_id = ${loser.id}`;
      await tx`update messages set company_id = ${survivor!.id} where company_id = ${loser.id}`;

      // A tenant that knew both companies ends up with one view: tags unioned,
      // notes kept end to end, rather than one silently winning.
      await tx`
      update tenant_company t set
        tags  = (select array(select distinct unnest(t.tags || l.tags))),
        notes = case
                  when t.notes is null then l.notes
                  when l.notes is null then t.notes
                  else t.notes || E'\n' || l.notes
                end,
        relationship = coalesce(t.relationship, l.relationship),
        updated_at = now()
      from tenant_company l
      where l.company_id = ${loser.id}
        and t.company_id = ${survivor!.id}
        and t.tenant_id = l.tenant_id
    `;
      await tx`
      delete from tenant_company l
      where l.company_id = ${loser.id}
        and exists (
          select 1 from tenant_company t
          where t.company_id = ${survivor!.id} and t.tenant_id = l.tenant_id
        )
    `;
      await tx`update tenant_company set company_id = ${survivor!.id} where company_id = ${loser.id}`;

      await tx`
      update companies set merged_into = ${survivor!.id}, updated_at = now()
      where id = ${loser.id}
    `;
    }
  });

  if (tenantId && loserIds.length) {
    await emit(tx, {
      tenantId,
      type: "company.merged",
      subjectType: "company",
      subjectId: survivor!.id,
      payload: { survivor: survivor!.id, losers: loserIds },
    });
  }

  return { survivor: survivor!, losers: loserIds };
}

async function fuzzyMatch(
  tx: Tx,
  nameNormalized: string,
  country: string | null,
): Promise<CompanyRow | undefined> {
  if (!nameNormalized) return undefined;

  const [row] = await tx<CompanyRow[]>`
    select * from companies
    where merged_into is null
      and (country is null or ${country}::text is null or country = ${country})
      and similarity(name_normalized, ${nameNormalized}) >= ${FUZZY_LINK_THRESHOLD}
    order by similarity(name_normalized, ${nameNormalized}) desc
    limit 1
  `;
  return row;
}

async function insertCompany(
  tx: Tx,
  name: string,
  nameNormalized: string,
  country: string | null,
): Promise<CompanyRow> {
  const [row] = await tx<CompanyRow[]>`
    insert into companies (name, name_normalized, country)
    values (${name}, ${nameNormalized}, ${country})
    returning *
  `;
  if (!row) throw new Error("registry.upsert inserted no company");
  return row;
}

type AttachOutcome =
  | { kind: "added" }
  | { kind: "present" }
  | { kind: "conflict"; heldBy: string }
  | { kind: "raced" };

/**
 * A weak identifier already pointing elsewhere is left where it is: a phone
 * genuinely can belong to another company now. A strong one pointing elsewhere
 * should have been caught by the match, so it means a race.
 */
async function attach(
  tx: Tx,
  companyId: string,
  identifier: Identifier,
): Promise<AttachOutcome> {
  const inserted = await tx<IdentifierRow[]>`
    insert into company_identifiers (company_id, type, value)
    values (${companyId}, ${identifier.type}, ${identifier.value})
    on conflict (type, value) do nothing
    returning *
  `;
  if (inserted[0]) return { kind: "added" };

  const holder = await findByIdentifier(tx, identifier.type, identifier.value);
  if (!holder || holder.id === companyId) return { kind: "present" };

  return isStrong(identifier.type)
    ? { kind: "raced" }
    : { kind: "conflict", heldBy: holder.id };
}

export async function upsertTenantView(
  tx: Tx,
  tenantId: string,
  companyId: string,
  view: TenantView | undefined,
): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    insert into tenant_company (tenant_id, company_id, relationship, tags, notes)
    values (${tenantId}, ${companyId}, ${view?.relationship ?? null},
            ${view?.tags ?? []}, ${view?.notes ?? null})
    on conflict (tenant_id, company_id) do update set
      relationship = coalesce(excluded.relationship, tenant_company.relationship),
      tags         = case when cardinality(excluded.tags) > 0
                          then excluded.tags else tenant_company.tags end,
      notes        = coalesce(excluded.notes, tenant_company.notes),
      updated_at   = now()
    returning *
  `;
  return row;
}
