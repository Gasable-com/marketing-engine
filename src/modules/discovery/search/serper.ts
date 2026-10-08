import { env } from '../../../env.js';
import { PermanentError } from '../errors.js';

/**
 * Serper: Google web results through /search, Google Maps listings through
 * /places. Plain fetch, throttled in-process, and only the fields discovery
 * uses are kept: nothing else from a response is ever stored.
 */

const BASE = 'https://google.serper.dev';

export type WebHit = { title: string; link: string; snippet: string; position: number };
export type PlaceHit = {
  title: string;
  address: string | null;
  phoneNumber: string | null;
  website: string | null;
  cid: string | null;
  placeId: string | null;
  category: string | null;
  rating: number | null;
  ratingCount: number | null;
};

export type SearchQuery = { q: string; gl: string; hl: string; page?: number };

/** The trimmed hits, and what Serper said the call cost in its own credits. */
export type Answer<T> = { hits: T[]; credits: number };

/** Tests answer from saved responses; nothing else replaces it. */
let fetcher: typeof fetch = (...args) => fetch(...args);
export function setSerperFetch(f: typeof fetch | null): void {
  fetcher = f ?? ((...args) => fetch(...args));
  last = 0;
}

export function serperConfigured(): boolean {
  return Boolean(env().SERPER_API_KEY);
}

// One call at a time, spaced at least 1/SERPER_RPS seconds apart, across the
// whole process: the key's limit is per key, not per task.
let chain: Promise<unknown> = Promise.resolve();
let last = 0;
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const gap = 1000 / env().SERPER_RPS;
    const wait = last + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = env().SERPER_API_KEY;
  if (!key) throw new PermanentError('search provider not configured');

  return throttled(async () => {
    let res: Response;
    try {
      res = await fetcher(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error('search provider unreachable');
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && json) return json;

    const message = typeof json?.['message'] === 'string' ? json['message'].slice(0, 120) : `HTTP ${res.status}`;
    // Out of credits arrives as a 400; a bad key as 401/403. Neither gets
    // better by asking again.
    if ([400, 401, 402, 403].includes(res.status)) {
      throw new PermanentError(`search provider refused: ${message}`);
    }
    throw new Error(`search provider failed: ${message}`);
  });
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Every Serper answer carries `credits` (1 for ten results, 2 for more). One
// when it says nothing: no call is free, and a missing field is not a refund.
const creditsOf = (json: Record<string, unknown>): number => num(json['credits']) ?? 1;

export async function searchWeb(query: SearchQuery): Promise<Answer<WebHit>> {
  const json = await post('/search', { q: query.q, gl: query.gl, hl: query.hl, page: query.page ?? 1 });
  const organic = Array.isArray(json['organic']) ? (json['organic'] as Record<string, unknown>[]) : [];
  const hits = organic
    .map((o, i) => ({
      title: str(o['title']) ?? '',
      link: str(o['link']) ?? '',
      snippet: str(o['snippet']) ?? '',
      position: num(o['position']) ?? i + 1,
    }))
    .filter((h) => h.link);
  return { hits, credits: creditsOf(json) };
}

export async function searchPlaces(query: SearchQuery): Promise<Answer<PlaceHit>> {
  const json = await post('/places', { q: query.q, gl: query.gl, hl: query.hl });
  const places = Array.isArray(json['places']) ? (json['places'] as Record<string, unknown>[]) : [];
  const hits = places
    .map((p) => ({
      title: str(p['title']) ?? '',
      address: str(p['address']),
      phoneNumber: str(p['phoneNumber']),
      website: str(p['website']),
      cid: str(p['cid']),
      placeId: str(p['placeId']),
      category: str(p['category']),
      rating: num(p['rating']),
      ratingCount: num(p['ratingCount']),
    }))
    .filter((p) => p.title && (p.cid || p.website));
  return { hits, credits: creditsOf(json) };
}
