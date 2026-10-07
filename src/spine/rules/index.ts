import jsonLogic from 'json-logic-js';
import type { Tx } from '../../db/client.js';

export type RuleScope = 'platform' | 'region' | 'tenant';

export type RuleRow = {
  id: string;
  scope: RuleScope;
  region: string | null;
  tenant_id: string | null;
  kind: string;
  name: string;
  document: unknown;
  enabled: boolean;
  created_at: Date;
};

export type RuleRef = { id: string; name: string; scope: RuleScope };

export type EvaluateInput = {
  kind: string;
  tenantId: string;
  region: string | null;
  context: Record<string, unknown>;
};

export type EvaluateResult = { denied: boolean; byRule?: RuleRef };

/**
 * Run every enabled rule of `kind` against `context`, in scope order:
 * platform, then the contact's region, then the tenant's own. A rule document
 * that evaluates truthy is a deny, and the first one wins — so a tenant can
 * add restrictions but never lift a platform or region one.
 *
 * json-logic lives behind this function; nothing outside this folder knows the
 * documents are json-logic.
 */
export async function evaluate(tx: Tx, input: EvaluateInput): Promise<EvaluateResult> {
  const rules = await load(tx, input);

  for (const rule of rules) {
    let denied: boolean;
    try {
      denied = jsonLogic.apply(asDocument(rule.document) as never, input.context) === true;
    } catch (err) {
      // A broken document must not quietly allow the whole call, and must not
      // take down every other rule either. Skip it and keep going.
      console.error(`rules: ${input.kind} rule ${rule.id} (${rule.name}) threw, skipping`, err);
      continue;
    }
    if (denied) {
      return { denied: true, byRule: { id: rule.id, name: rule.name, scope: rule.scope } };
    }
  }

  return { denied: false };
}

export type DecideInput = EvaluateInput;
export type DecideResult<T> = { value: T | null; byRule?: RuleRef };

/**
 * Like evaluate, but for rule kinds that answer with a value rather than a
 * verdict: the first rule producing something other than null wins.
 *
 * Scope order is the reverse of evaluate's — tenant, then region, then
 * platform — because a value rule states a preference, not a restriction. A
 * tenant choosing its own channel order takes nothing away: whatever order
 * comes back, every channel in it still has to pass can_send in full. The
 * platform row is a default, and the most specific rule should beat a default.
 * Denial rules keep the opposite order, so a tenant can never lift one.
 */
export async function decide<T>(tx: Tx, input: DecideInput): Promise<DecideResult<T>> {
  const rules = await load(tx, input, 'specific-first');

  for (const rule of rules) {
    let value: unknown;
    try {
      value = jsonLogic.apply(asDocument(rule.document) as never, input.context);
    } catch (err) {
      console.error(`rules: ${input.kind} rule ${rule.id} (${rule.name}) threw, skipping`, err);
      continue;
    }
    if (value !== null && value !== undefined) {
      return { value: value as T, byRule: { id: rule.id, name: rule.name, scope: rule.scope } };
    }
  }

  return { value: null };
}

/**
 * Every value the enabled rules of a value kind give, in any scope, for one
 * context. For a kind whose rows each describe something (one row per
 * country) and a caller that needs all of them, not the one that applies.
 */
export async function allValues<T>(tx: Tx, kind: string, context: Record<string, unknown>): Promise<T[]> {
  const rows = await tx<RuleRow[]>`select * from rules where kind = ${kind} and enabled order by created_at, id`;
  const values: T[] = [];
  for (const rule of rows) {
    try {
      const value = jsonLogic.apply(asDocument(rule.document) as never, context);
      if (value !== null && value !== undefined) values.push(value as T);
    } catch (err) {
      console.error(`rules: ${kind} rule ${rule.id} (${rule.name}) threw, skipping`, err);
    }
  }
  return values;
}

function load(
  tx: Tx,
  input: EvaluateInput,
  order: 'broad-first' | 'specific-first' = 'broad-first',
): Promise<RuleRow[]> {
  const rank =
    order === 'broad-first'
      ? tx`case scope when 'platform' then 0 when 'region' then 1 else 2 end`
      : tx`case scope when 'tenant' then 0 when 'region' then 1 else 2 end`;

  return tx<RuleRow[]>`
    select * from rules
    where kind = ${input.kind}
      and enabled
      and (
        scope = 'platform'
        or (scope = 'region' and region = ${input.region})
        or (scope = 'tenant' and tenant_id = ${input.tenantId})
      )
    order by ${rank}, created_at, id
  `;
}

/**
 * Run one json-logic document that is not a row in `rules` — a condition
 * carried inline on something else, like a promocode's own eligibility. Returns
 * the raw result; the caller decides what truthy means, since an inline
 * document is usually a permit condition rather than a deny one.
 *
 * Here so json-logic stays behind this folder.
 */
export function applyDocument(document: unknown, context: Record<string, unknown>): unknown {
  return jsonLogic.apply(asDocument(document) as never, context);
}

/**
 * A document stored double-encoded — a jsonb holding a JSON *string* rather
 * than an object, which is what `JSON.stringify(doc)::jsonb` produces — would
 * otherwise evaluate to that string, which json-logic treats as a constant.
 * For a deny rule that means silently never firing, so unwrap it once.
 */
function asDocument(document: unknown): unknown {
  if (typeof document !== 'string') return document;
  try {
    return JSON.parse(document);
  } catch {
    return document;
  }
}

/** Rules this tenant may see: platform, region and its own. */
export async function listForTenant(tx: Tx): Promise<RuleRow[]> {
  return tx<RuleRow[]>`
    select * from rules
    order by case scope when 'platform' then 0 when 'region' then 1 else 2 end,
             created_at,
             id
  `;
}

export async function createTenantRule(
  tx: Tx,
  input: { tenantId: string; kind: string; name: string; document: unknown },
): Promise<RuleRow> {
  const [row] = await tx<RuleRow[]>`
    insert into rules (scope, tenant_id, kind, name, document)
    values ('tenant', ${input.tenantId}, ${input.kind}, ${input.name},
            ${tx.json(input.document as never)})
    returning *
  `;
  if (!row) throw new Error('rules.createTenantRule inserted no row');
  return row;
}

/** Deletes only the tenant's own rule; the RLS policy blocks anything else. */
export async function deleteTenantRule(tx: Tx, id: string): Promise<boolean> {
  const deleted = await tx`delete from rules where id = ${id}`;
  return deleted.count > 0;
}
