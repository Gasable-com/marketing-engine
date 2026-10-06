import type { Tx } from '../../../db/client.js';

export type FinderQuery = {
  /** Category codes the buyer should purchase. */
  buys?: string[] | undefined;
  sector?: string | undefined;
  city?: string | undefined;
  country?: string | undefined;
  /** Free text. What it means is the implementation's business. */
  text?: string | undefined;
  excludeCompanyIds?: string[] | undefined;
  limit: number;
  /** Product terms, any language. Read by `products`; `basic` ignores them. */
  products?: string[] | undefined;
  /** Supply-chain roles, as profile roles. Read by `products`; `basic` ignores them. */
  roles?: string[] | undefined;
  /** City names. Read by `products`; `basic` ignores them. */
  cities?: string[] | undefined;
};

export type Candidate = {
  companyId: string;
  /** 0..1, higher is better. Comparable across calls of one finder, not between finders. */
  score: number;
  /** Human-readable, e.g. "buys: diesel". Shown to whoever is deciding. */
  reasons: string[];
};

/**
 * How discovery asks "who should this tenant talk to?".
 *
 * Any implementation must: never return a company with `merged_into` or
 * `on_platform_ref` set, never return more than `limit`, and keep `score`
 * comparable within itself. Swapping the algorithm is a new file and one line
 * in the registry; nothing outside this folder changes.
 */
export interface Finder {
  /** Recorded on every finder_runs row, so a search can be attributed later. */
  readonly name: string;
  find(tx: Tx, tenantId: string, query: FinderQuery): Promise<Candidate[]>;
}
