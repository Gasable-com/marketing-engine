import type { Tx } from '../../../db/client.js';
import { foldText } from '../../../spine/registry/index.js';
import type { Candidate, Finder, FinderQuery } from './types.js';

/**
 * RANK BY WHAT A COMPANY SAYS IT SELLS. The finder a discovery job ranks the
 * pool with: given product terms in any language, it returns the companies
 * whose profile lists a matching product, best first.
 *
 * A term matches a product when the folded term is inside the folded product
 * (`ديزل` in `توريد الديزل`, `diesel` in `Diesel fuel`), or when their trigram
 * similarity is at least MATCH_SIMILARITY. Folding is foldText(), not
 * normalizeName(): in product text a word like شركة is meaning, not noise.
 * The terms are folded here, the stored products by fold_text() in SQL, which
 * is the same folding.
 *
 * Only companies with a matching product come back; roles, cities, quality
 * and freshness then order them. Every signal that scored is one reason, so
 * whoever reviews a result sees why it is there.
 *
 * What the interface guarantees, and what this upholds: no merged-away
 * company, no company already on the marketplace, never more than `limit`.
 */

// The weights add up to 1. They are constants until they are tuned against
// reviewed results; then they move to rule rows.
const WEIGHT_PRODUCT = 0.5;
const WEIGHT_ROLE = 0.15;
const WEIGHT_CITY = 0.15;
const WEIGHT_QUALITY_FULL = 0.1;
const WEIGHT_QUALITY_THIN = 0.05;
const WEIGHT_FRESH = 0.1;

/** Trigram similarity at which a term matches a product it is not inside. */
const MATCH_SIMILARITY = 0.4;

/** Profiled within this many days counts as fully fresh... */
const FRESH_DAYS = 90;
/** ...falling linearly to nothing at this many. */
const STALE_DAYS = 365;

type Row = {
  id: string;
  term: string;
  product: string;
  similarity: number;
  role: string | null;
  city: string | null;
  quality: 'full' | 'thin' | null;
  age_days: number | null;
  freshness: number;
  score: number;
};

export const productsFinder: Finder = {
  name: 'products',

  async find(tx: Tx, tenantId: string, query: FinderQuery): Promise<Candidate[]> {
    void tenantId; // the pool is shared; nothing here is tenant-specific yet

    const terms = (query.products ?? [])
      .map((term) => ({ term, folded: foldText(term) }))
      .filter((t) => t.folded);
    if (terms.length === 0) return [];

    const roles = query.roles ?? [];
    const cities = (query.cities ?? []).map(foldText).filter(Boolean);
    const excluded = query.excludeCompanyIds?.length ? query.excludeCompanyIds : null;
    const country = query.country ?? null;

    const rows = await tx<Row[]>`
      with terms as (
        select term, folded
        from unnest(${terms.map((t) => t.term)}::text[], ${terms.map((t) => t.folded)}::text[])
          as t (term, folded)
      ),
      pool as (
        select c.id, c.created_at, p.products, p.roles, p.cities, p.quality, p.profiled_at
        from companies c
        join company_profiles p on p.company_id = c.id
        where c.merged_into is null
          and c.on_platform_ref is null
          and (${excluded}::uuid[] is null or c.id <> all(${excluded}::uuid[]))
          and (${country}::text is null
               or c.country = ${country}::text
               or ${country}::text = any(p.countries))
      ),
      pairs as (
        select pool.id, t.term, pr.product, fold_text(pr.product) as folded_product, t.folded
        from pool
        cross join lateral unnest(pool.products) as pr (product)
        cross join terms t
      ),
      scored_pairs as (
        select id, term, product,
               case when strpos(folded_product, folded) > 0 then 1
                    else similarity(folded, folded_product) end::float8 as similarity
        from pairs
      ),
      best as (
        -- The best-matching term and product per company; ties go to the
        -- earlier term, then the product name, so a rerun reads the same.
        select distinct on (id) id, term, product, similarity
        from scored_pairs
        where similarity >= ${MATCH_SIMILARITY}::float8
        order by id, similarity desc, term, product
      ),
      signals as (
        select best.*, pool.created_at, pool.quality, pool.profiled_at,
               (select r from unnest(pool.roles) r
                where r = any(${roles}::text[]) order by r limit 1) as role,
               (select c from unnest(pool.cities) c
                where fold_text(c) = any(${cities}::text[]) order by c limit 1) as city,
               extract(epoch from now() - pool.profiled_at)::float8 / 86400 as age_days
        from best join pool using (id)
      ),
      fresh as (
        select signals.*,
               case when age_days is null then 0
                    when age_days <= ${FRESH_DAYS}::float8 then 1
                    when age_days >= ${STALE_DAYS}::float8 then 0
                    else (${STALE_DAYS}::float8 - age_days) / (${STALE_DAYS - FRESH_DAYS}::float8)
               end::float8 as freshness
        from signals
      )
      select id::text, term, product, similarity, role, city, quality, age_days, freshness,
             ( ${WEIGHT_PRODUCT}::float8 * similarity
             + case when role is not null then ${WEIGHT_ROLE}::float8 else 0 end
             + case when city is not null then ${WEIGHT_CITY}::float8 else 0 end
             + case quality when 'full' then ${WEIGHT_QUALITY_FULL}::float8
                            when 'thin' then ${WEIGHT_QUALITY_THIN}::float8
                            else 0 end
             + ${WEIGHT_FRESH}::float8 * freshness
             ) as score
      from fresh
      order by score desc, profiled_at desc nulls last, created_at desc, id
      limit ${query.limit}
    `;

    return rows.map((row) => ({
      companyId: row.id,
      score: row.score,
      reasons: reasons(row),
    }));
  },
};

/** One reason per signal that scored. */
function reasons(row: Row): string[] {
  const out = [`product: ${row.term} ~ ${row.product}`];
  if (row.role) out.push(`role: ${row.role}`);
  if (row.city) out.push(`city: ${row.city}`);
  if (row.quality) out.push(`profile: ${row.quality}`);
  if (row.freshness > 0 && row.age_days !== null) {
    const days = Math.max(0, Math.floor(row.age_days));
    out.push(`profiled ${days} ${days === 1 ? 'day' : 'days'} ago`);
  }
  return out;
}
