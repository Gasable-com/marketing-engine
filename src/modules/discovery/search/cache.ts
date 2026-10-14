import { db } from '../../../db/client.js';
import { env } from '../../../env.js';
import { searchPlaces, searchWeb, type Answer, type PlaceHit, type SearchQuery, type WebHit } from './serper.js';

/**
 * search_queries: Serper's answers, trimmed, shared by every tenant. A query
 * asked again within SEARCH_CACHE_DAYS is answered from here with no call.
 *
 * Plain statements on the pool, not a tenant transaction: the table holds no
 * tenant data, and no transaction should stay open across a network call.
 */

const PROVIDER = 'serper';

export type Cached<T> = {
  hits: T[];
  fromCache: boolean;
  /** Serper's credits for this answer: none when the cache had it. */
  credits: number;
};

async function cached<T>(
  kind: 'web' | 'places',
  query: SearchQuery,
  fetchHits: () => Promise<Answer<T>>,
): Promise<Cached<T>> {
  const page = query.page ?? 1;
  const sql = db();
  const [hit] = await sql<{ results: T[] }[]>`
    select results from search_queries
    where provider = ${PROVIDER} and kind = ${kind} and q = ${query.q}
      and gl = ${query.gl} and hl = ${query.hl} and page = ${page}
      and fetched_at > now() - make_interval(days => ${env().SEARCH_CACHE_DAYS})
  `;
  if (hit) return { hits: hit.results, fromCache: true, credits: 0 };

  const { hits, credits } = await fetchHits();
  await sql`
    insert into search_queries (provider, kind, q, gl, hl, page, results, result_count)
    values (${PROVIDER}, ${kind}, ${query.q}, ${query.gl}, ${query.hl}, ${page},
            ${sql.json(hits as never)}, ${hits.length})
    on conflict (provider, kind, q, gl, hl, page) do update set
      results = excluded.results, result_count = excluded.result_count, fetched_at = now()
  `;
  return { hits, fromCache: false, credits };
}

export function webSearch(query: SearchQuery): Promise<Cached<WebHit>> {
  return cached('web', query, () => searchWeb(query));
}

export function placesSearch(query: SearchQuery): Promise<Cached<PlaceHit>> {
  return cached('places', query, () => searchPlaces(query));
}

/** discovery.cache.prune: runs as the owner, across the shared table. */
export async function pruneSearchCache(): Promise<number> {
  const deleted = await db()`delete from search_queries where fetched_at < now() - interval '90 days'`;
  return deleted.count;
}
