import { canonicalSocial, isNoiseWord } from '../../../spine/registry/index.js';
import type { TaskRow } from '../jobs.js';
import { webSearch } from '../search/cache.js';
import { recordQuery } from '../search/cost.js';
import type { WebHit } from '../search/serper.js';
import { sameName } from './check.js';

/**
 * One web query for a company's LinkedIn page, when its own pages linked
 * none. A URL on linkedin.com says where a page is, not whose: a hit is taken
 * only when its title or its slug carries the name that was saved.
 */

export type LinkedinFound = { q: string; url: string; title: string; value: string };

/** The page found, or null for a miss. Throws what webSearch throws. */
export async function lookupLinkedin(task: TaskRow, name: string, gl: string): Promise<LinkedinFound | null> {
  // Unquoted: a quoted Maps title with its branch, its "Est." or Google's own
  // typo matched nothing on staging. The name check below keeps precision.
  const q = `${searchName(name)} site:linkedin.com/company`;
  const result = await webSearch({ q, gl, hl: 'en' });
  await recordQuery(task, { personaId: null, kind: 'web', q, gl, hl: 'en', lookup: 'linkedin' }, result);
  const hit = result.hits.find((h) => namesCompany(h, name));
  if (!hit) return null;
  return { q, url: hit.link, title: hit.title, value: canonicalSocial(hit.link)!.value };
}

/**
 * The name as a search asks for it: no aside in brackets, no trailing branch
 * ("Riyadh Branch", "فرع الرياض"), no punctuation and no legal-form or trade
 * words. A name that is nothing but those is searched as it was saved.
 */
export function searchName(name: string): string {
  const core = name
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s*[-–|,،]?\s*(?:\p{L}+\s+)?branch\s*$/iu, ' ')
    .replace(/\s*[-–|,،]?\s*فرع(?:\s+\S+){0,2}\s*$/u, ' ');
  const words = core.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !isNoiseWord(w));
  return words.join(' ') || name.trim();
}

/** A company page whose title, less its "| LinkedIn", or whose slug is the name, with or without its branch. */
export function namesCompany(hit: WebHit, name: string): boolean {
  const profile = canonicalSocial(hit.link);
  if (profile?.network !== 'linkedin') return false;
  const title = hit.title.replace(/\s*[|-]\s*LinkedIn\s*$/i, '');
  const slug = profile.value.slice('linkedin.com/company/'.length).replace(/-/g, ' ');
  return [name, searchName(name)].some((n) => sameName(title, n) || sameName(slug, n));
}
