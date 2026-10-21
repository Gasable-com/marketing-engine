import { Hono } from 'hono';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import { CsvFormatError, readImport, splitList } from '../../spine/registry/csv.js';
import { setProfile } from '../../modules/discovery/index.js';
import {
  IDENTIFIER_TYPES,
  findByIdentifier,
  get,
  groupSocials,
  normalizeIdentifiers,
  upsert,
  upsertTenantView,
  type CompanyDetail,
  type IdentifierType,
} from '../../spine/registry/index.js';
import type { AuthVars } from '../middleware/auth.js';

const MAX_IMPORT_ROWS = 5000;

const identifier = z.object({
  type: z.enum(IDENTIFIER_TYPES),
  value: z.string().min(1).max(320),
});

const tenantView = z.object({
  relationship: z.enum(['customer', 'supplier', 'prospect', 'other']).optional(),
  tags: z.array(z.string().min(1).max(60)).max(50).optional(),
  notes: z.string().max(5000).optional(),
});

const createBody = z.object({
  name: z.string().min(1).max(500),
  country: z.string().length(2).optional(),
  identifiers: z.array(identifier).max(50).default([]),
  source: z.object({
    // A lookup source is the registry's own doing, not a caller's claim.
    type: z.enum(['rfq', 'import', 'api']),
    ref: z.string().min(1).max(200).optional(),
  }),
  enrich: z.boolean().optional(),
  defaultCountry: z.string().length(2).optional(),
  tenantView: tenantView.optional(),
});

export const companies = new Hono<AuthVars>();

/** A company as the API shows it: its social profiles grouped into links. */
function present(detail: CompanyDetail) {
  return { ...detail, socials: groupSocials(detail.identifiers) };
}

companies.post('/v1/companies', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const result = await withTenant(tenantId, (tx) =>
    upsert(tx, {
      ...parsed.data,
      source: { ...parsed.data.source, tenantId },
    }),
  );

  return c.json(
    {
      company: result.company,
      created: result.created,
      mergedFrom: result.mergedFrom,
    },
    201,
  );
});

companies.get('/v1/companies', async (c) => {
  const raw = c.req.query('identifier');
  if (!raw) return c.json({ error: 'identifier query parameter is required' }, 400);

  const separator = raw.indexOf(':');
  const type = raw.slice(0, separator);
  const value = raw.slice(separator + 1);
  if (!IDENTIFIER_TYPES.includes(type as IdentifierType) || !value) {
    return c.json({ error: `identifier must be one of ${IDENTIFIER_TYPES.join(', ')}:<value>` }, 400);
  }

  const tenantId = c.get('tenantId');
  // Match the stored form, not whatever the caller typed. The type ends at
  // the first ':', so a value may carry its own (`social:https://…`).
  const normalized = normalizeIdentifiers([{ type, value }]).identifiers.find(
    (i) => i.type === type,
  );
  if (!normalized) return c.json({ error: 'not found' }, 404);

  const detail = await withTenant(tenantId, async (tx) => {
    const company = await findByIdentifier(tx, normalized.type, normalized.value);
    return company ? get(tx, company.id) : undefined;
  });

  return detail ? c.json(present(detail)) : c.json({ error: 'not found' }, 404);
});

companies.get('/v1/companies/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const detail = await withTenant(c.get('tenantId'), (tx) => get(tx, id.data));
  return detail ? c.json(present(detail)) : c.json({ error: 'not found' }, 404);
});

companies.put('/v1/companies/:id/view', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'not found' }, 404);

  const parsed = tenantView.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);

  const tenantId = c.get('tenantId');
  const view = await withTenant(tenantId, async (tx) => {
    const detail = await get(tx, id.data);
    if (!detail) return null;
    return upsertTenantView(tx, tenantId, detail.company.id, parsed.data);
  });

  return view ? c.json({ view }) : c.json({ error: 'not found' }, 404);
});

/**
 * Bulk import. Synchronous: 5,000 rows is a few seconds, and a caller that has
 * just uploaded a file would rather wait than poll.
 */
companies.post('/v1/companies/import', async (c) => {
  const tenantId = c.get('tenantId');
  const ref = c.req.query('ref') ?? 'import';

  let rows;
  try {
    rows = readImport(await c.req.text());
  } catch (err) {
    if (err instanceof CsvFormatError) return c.json({ error: err.message }, 400);
    throw err;
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    return c.json({ error: `at most ${MAX_IMPORT_ROWS} rows per import` }, 400);
  }

  const summary = { rows: rows.length, created: 0, linked: 0, merged: 0 };
  const rejected: { row: number; reason: string }[] = [];

  for (const [index, row] of rows.entries()) {
    // Row 1 is the header, so the first data row is row 2 to whoever is
    // looking at the file.
    const lineNumber = index + 2;

    if (!row.name) {
      rejected.push({ row: lineNumber, reason: 'name is required' });
      continue;
    }

    const identifiers = (['cr', 'vat', 'domain', 'phone', 'email'] as const)
      .filter((type) => row[type])
      .map((type) => ({ type, value: row[type] }));

    // A row that offered identifiers and had none of them survive normalisation
    // contributes nothing we could ever match on, and would land as a name-only
    // company that quietly duplicates. Reject it and say which line.
    if (identifiers.length > 0) {
      const { identifiers: usable, rejected: bad } = normalizeIdentifiers(identifiers, {
        ...(row.country ? { defaultCountry: row.country.toUpperCase() } : {}),
      });
      if (usable.length === 0) {
        rejected.push({ row: lineNumber, reason: bad[0]?.reason ?? 'no usable identifier' });
        continue;
      }
    }

    try {
      const result = await withTenant(tenantId, (tx) =>
        upsert(tx, {
          name: row.name,
          ...(row.country ? { country: row.country.toUpperCase() } : {}),
          identifiers,
          source: { type: 'import', ref: `${ref}:${lineNumber}`, tenantId },
          ...(row.country ? { defaultCountry: row.country.toUpperCase() } : {}),
          tenantView: {
            ...(row.relationship
              ? { relationship: row.relationship as 'customer' | 'supplier' | 'prospect' | 'other' }
              : {}),
            ...(row.tags ? { tags: splitList(row.tags) } : {}),
          },
        }),
      );

      if (result.created) summary.created += 1;
      else summary.linked += 1;
      summary.merged += result.mergedFrom.length;

      // The profile columns are optional; a file without them leaves profiles
      // exactly as they were.
      if (row.buys || row.sells || row.sector || row.city) {
        await withTenant(tenantId, (tx) =>
          setProfile(tx, {
            tenantId,
            companyId: result.company.id,
            ...(row.buys ? { buys: splitList(row.buys) } : {}),
            ...(row.sells ? { sells: splitList(row.sells) } : {}),
            ...(row.sector ? { sector: row.sector } : {}),
            ...(row.city ? { city: row.city } : {}),
          }),
        );
      }
    } catch (err) {
      rejected.push({ row: lineNumber, reason: (err as Error).message });
    }
  }

  return c.json({ ...summary, rejected });
});
