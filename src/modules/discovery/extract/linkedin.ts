import { canonicalSocial, foldText, isNoiseWord, normalizeDomain } from '../../../spine/registry/index.js';
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

/**
 * Where the company is, to tell its page from a namesake's abroad: the
 * country's Google code, its names and cities in every language its rule row
 * has, and the company's own domain when its site was read.
 */
export type LinkedinPlace = { gl: string; countryNames: string[]; cities: string[]; domain: string | null };

/** The page found, or null for a miss. Throws what webSearch throws. */
export async function lookupLinkedin(task: TaskRow, name: string, place: LinkedinPlace): Promise<LinkedinFound | null> {
  // Unquoted: a quoted Maps title with its branch, its "Est." or Google's own
  // typo matched nothing on staging. The name and place checks keep precision.
  const q = `${searchName(name)} site:linkedin.com/company`;
  const { gl } = place;
  const result = await webSearch({ q, gl, hl: 'en' });
  await recordQuery(task, { personaId: null, kind: 'web', q, gl, hl: 'en', lookup: 'linkedin' }, result);
  const hit = pickLinkedin(result.hits, name, place);
  if (!hit) return null;
  return { q, url: hit.link, title: hit.title, value: canonicalSocial(hit.link)!.value };
}

/**
 * The first hit that names the company and whose page is shown to be in its
 * country. Serper often lists one page several times, once per LinkedIn
 * country site, so any listing of the same page can carry the place. On
 * staging a Tampa company and a Saudi shop both folded to "united
 * innovations"; only the place told them apart.
 */
export function pickLinkedin(hits: WebHit[], name: string, place: LinkedinPlace): WebHit | null {
  const placed = new Set<string>();
  for (const h of hits) {
    const profile = canonicalSocial(h.link);
    if (profile?.network === 'linkedin' && inPlace(h, name, place)) placed.add(profile.value);
  }
  return hits.find((h) => namesCompany(h, name) && placed.has(canonicalSocial(h.link)!.value)) ?? null;
}

/**
 * Whether a listing's title or snippet puts the company in the country: the
 * company's own domain; a country name of more than one word ("Saudi
 * Arabia"); or a location as LinkedIn writes one, two places either side of a
 * comma ("Dammam, Saudi Arabia", "Riyadh, Riyadh"). A lone word is never
 * enough: "saudi" is in Saudi Aramco, المملكة is any kingdom, Medina is in
 * Ohio and الخبر is also "the news". The LinkedIn host is no evidence either:
 * every page is served under every country's subdomain. A place word in the
 * company's own name places nothing, since every namesake's title has it.
 */
function inPlace(hit: WebHit, name: string, place: LinkedinPlace): boolean {
  const raw = `${hit.title} ${hit.snippet}`;
  if (place.domain && hostsIn(raw).some((h) => normalizeDomain(h) === place.domain)) return true;

  const own = ` ${foldText(name)} `;
  const usable = (w: string) => w.length > 1 && !own.includes(` ${w} `);
  const countries = place.countryNames.map(foldText).filter(usable);
  const places = [...countries, ...place.cities.map(foldText).filter(usable)];
  // Clauses kept apart at commas, so a location's two halves can be paired.
  const text = ` ${raw.split(/[,،]/).map(foldText).join(' , ')} `;

  if (countries.some((w) => w.includes(' ') && withPrefixes(w).some((f) => text.includes(` ${f} `)))) return true;
  return places.some((a) => withPrefixes(a).some((f) => places.some((b) => text.includes(` ${f} , ${b} `))));
}

/** Host names in free text, as a snippet's "Website: www.acme.com.sa" writes them. */
function hostsIn(text: string): string[] {
  return text.toLowerCase().match(/(?:[a-z0-9-]+\.)+[a-z]{2,}/g) ?? [];
}

/**
 * An Arabic word as a snippet may write it, with "and", "in", "to" or "so"
 * joined to it: بالرياض, والسعودية, للرياض (ل before ال drops the alif).
 */
function withPrefixes(word: string): string[] {
  if (!/^\p{Script=Arabic}/u.test(word)) return [word];
  const forms = [word, ...['و', 'ب', 'ل', 'ف'].map((p) => p + word)];
  if (word.startsWith('ال')) forms.push(`لل${word.slice(2)}`, `ولل${word.slice(2)}`);
  return forms;
}

/**
 * The name as a search asks for it: no aside in brackets, no trailing branch
 * ("Riyadh Branch", "فرع الرياض", "الفرع الرئيسي"), no punctuation and no
 * legal-form or trade words. A name that is nothing but those is searched as
 * it was saved.
 */
export function searchName(name: string): string {
  const core = name
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/(?:^|[\s|,،–-])\s*(?:\p{L}+\s+)?branch\s*$/iu, ' ')
    .replace(/(?:^|[\s|,،–-])\s*(?:ال)?فرع(?:\s+\S+){0,2}\s*$/u, ' ');
  const words = core.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !isNoiseWord(w));
  return words.join(' ') || name.trim();
}

/**
 * A company page whose title, less its "| LinkedIn", or whose slug is the
 * name, with or without its branch. A bilingual title ("United Innovations
 * Trading Co | شركة الإبتكارات المتحدة ...", or with a spaced dash) is two
 * names: either will do. A dash inside a name ("Al-Rashid") splits nothing.
 */
export function namesCompany(hit: WebHit, name: string): boolean {
  const profile = canonicalSocial(hit.link);
  if (profile?.network !== 'linkedin') return false;
  const titles = hit.title
    .replace(/\s*[|-]\s*LinkedIn\s*$/i, '')
    .split(/\s*\|\s*|\s+[–-]\s+/)
    .map((t) => t.replace(/\s*(?:\.\.\.|…)\s*$/, ''));
  const slug = profile.value.slice('linkedin.com/company/'.length).replace(/-/g, ' ');
  return [name, searchName(name)].some((n) => sameName(slug, n) || titles.some((t) => sameName(t, n)));
}
