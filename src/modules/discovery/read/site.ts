import { isSharedHost, normalizeDomain } from '../../../spine/registry/identifiers.js';
import { firecrawlScrape } from './firecrawl.js';
import { guardedGet, ReadError } from './fetch.js';
import { htmlToText, linksIn, type Link } from './text.js';

/**
 * Read one candidate's site into memory: the home page, then at most three
 * pages on the same registrable domain that look like products, about or
 * contact. Only the text is kept, capped per page and per candidate, and
 * nothing is written anywhere: the caller drops it once the candidate is done.
 */

const PAGE_CHARS = 20_000;
const CANDIDATE_CHARS = 40_000;
const MORE_PAGES = 3;

/** In the order they are read. Paths are percent-decoded and `-`/`_` read as spaces. */
const KINDS: RegExp[] = [
  /product|catalog|services|منتجات|خدمات/,
  /about|company|من نحن/,
  /contact|اتصل|تواصل/,
];

const NOT_A_PAGE = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|docx?|xlsx?|pptx?|mp4|mp3)$/i;

export type ReadPage = { url: string; text: string };
export type SiteRead = {
  pages: ReadPage[];
  failed: { url: string; reason: string }[];
  /** Pages read through Firecrawl, and through the plain fetch. */
  firecrawl: number;
  fetchFallback: number;
};

export async function readSite(input: { url: string | null; domain: string }): Promise<SiteRead> {
  const result: SiteRead = { pages: [], failed: [], firecrawl: 0, fetchFallback: 0 };
  const home = homeUrl(input.url, input.domain);
  if (isSharedHost(input.domain)) {
    result.failed.push({ url: home, reason: 'shared host' });
    return result;
  }

  let used = 0;
  const keep = (url: string, text: string): boolean => {
    if (result.pages.some((p) => p.url === url)) return true;
    const capped = text.slice(0, Math.min(PAGE_CHARS, CANDIDATE_CHARS - used));
    result.pages.push({ url, text: capped });
    used += capped.length;
    return used < CANDIDATE_CHARS;
  };

  const first = await readPage(home, input.domain, result);
  if (!first || !keep(first.url, first.text)) return result;

  const seen = new Set([key(home), key(first.url)]);
  for (const url of choosePages(first.links, input.domain, seen)) {
    const page = await readPage(url, input.domain, result);
    if (page && !keep(page.url, page.text)) break;
  }
  return result;
}

function homeUrl(url: string | null, domain: string): string {
  if (url) {
    try {
      const u = new URL(url);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && normalizeDomain(u.hostname) === domain) {
        return `${u.origin}${u.pathname}`;
      }
    } catch {
      // not a URL: read the domain's root instead
    }
  }
  return `https://${domain}/`;
}

/** A URL's identity for "same page": no fragment, no trailing slash. */
function key(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url;
  }
}

/** Products first, then about, then contact; one of each before any second of a kind. */
export function choosePages(links: Link[], domain: string, seen: Set<string>): string[] {
  const byKind: string[][] = KINDS.map(() => []);
  for (const link of links) {
    let u: URL;
    try {
      u = new URL(link.url);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (normalizeDomain(u.hostname) !== domain || NOT_A_PAGE.test(u.pathname)) continue;
    u.hash = '';
    const k = key(u.href);
    if (seen.has(k)) continue;
    const kind = KINDS.findIndex((re) => re.test(words(u.pathname, link.text)));
    if (kind < 0) continue;
    seen.add(k);
    byKind[kind]!.push(u.href);
  }
  const firsts = byKind.flatMap((list) => list.slice(0, 1));
  const seconds = byKind.flatMap((list) => list.slice(1));
  return [...firsts, ...seconds].slice(0, MORE_PAGES);
}

function words(path: string, text: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // a malformed escape: match on the raw path
  }
  return `${decoded} ${text}`.toLowerCase().replace(/[-_]+/g, ' ');
}

type Read = { url: string; text: string; links: Link[] };

/** Firecrawl first; the plain fetch when it is not configured or the scrape fails. */
async function readPage(url: string, domain: string, result: SiteRead): Promise<Read | null> {
  try {
    const scraped = await firecrawlScrape(url, { domain });
    if (scraped) {
      result.firecrawl++;
      return { url: scraped.finalUrl, text: scraped.text, links: scraped.links };
    }
  } catch (err) {
    if (!(err instanceof ReadError && err.reason === 'firecrawl failed')) {
      result.failed.push({ url, reason: err instanceof ReadError ? err.reason : 'read failed' });
      return null;
    }
  }

  try {
    const res = await guardedGet(url, { domain });
    if (res.status < 200 || res.status > 299) {
      result.failed.push({ url, reason: `http ${res.status}` });
      return null;
    }
    result.fetchFallback++;
    const isHtml = res.contentType !== 'text/plain';
    return {
      url: res.finalUrl,
      text: isHtml ? htmlToText(res.body) : res.body,
      links: isHtml ? linksIn(res.body, res.finalUrl) : [],
    };
  } catch (err) {
    result.failed.push({ url, reason: err instanceof ReadError ? err.reason : 'read failed' });
    return null;
  }
}
