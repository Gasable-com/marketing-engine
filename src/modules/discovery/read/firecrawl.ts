import { env } from '../../../env.js';
import { checkUrl, MAX_BYTES, readCapped, ReadError } from './fetch.js';
import { linksIn, markdownToText, type Link } from './text.js';

/**
 * The self-hosted Firecrawl, through plain fetch. Firecrawl follows redirects
 * and resolves names itself, so a page is used only when the URL it says it
 * ended on is still the candidate's domain and resolves to public addresses.
 *
 * The text is the page's main content, so Claude reads no menus; the links
 * are the whole page's, from its raw HTML, since the nav and the footer are
 * where the products page and the social profiles are linked.
 */

const TIMEOUT_MS = 30_000;
/** Markdown looked at; only 20 000 characters of a page's text are kept. */
const MAX_MARKDOWN = 300_000;

let fetcher: typeof fetch = (...args) => fetch(...args);

/** Tests answer from saved responses; nothing else replaces it. */
export function setFirecrawlFetch(f: typeof fetch | null): void {
  fetcher = f ?? ((...args) => fetch(...args));
}

export type Scraped = { finalUrl: string; text: string; links: Link[] };

type ScrapeBody = {
  success?: boolean;
  data?: {
    markdown?: string;
    rawHtml?: string;
    metadata?: { url?: string; sourceURL?: string; statusCode?: number };
  };
};

/** Null when Firecrawl is not configured; throws ReadError when it cannot be used. */
export async function firecrawlScrape(url: string, opts: { domain: string }): Promise<Scraped | null> {
  const base = env().FIRECRAWL_URL;
  if (!base) return null;
  await checkUrl(new URL(url), opts.domain);

  let body: ScrapeBody;
  try {
    const res = await fetcher(`${base.replace(/\/+$/, '')}/v1/scrape`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env().FIRECRAWL_API_KEY ?? 'none'}`,
      },
      body: JSON.stringify({ url, formats: ['markdown', 'rawHtml'], onlyMainContent: true, timeout: TIMEOUT_MS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok || !res.body) throw new Error();
    // The response carries a page's content, so it is capped like the plain fetch.
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error();
    body = JSON.parse((await readCapped(res.body)).toString('utf8')) as ScrapeBody;
  } catch {
    throw new ReadError('firecrawl failed');
  }
  const data = body.data;
  const status = data?.metadata?.statusCode;
  if (body.success !== true || !data || typeof data.markdown !== 'string' || (status ?? 200) >= 400) {
    throw new ReadError('firecrawl failed');
  }

  // No reported final URL means none to check, so the page is not used.
  const reported = [data.metadata?.url, data.metadata?.sourceURL].find((u) => typeof u === 'string' && u);
  if (!reported) throw new ReadError('firecrawl failed');
  const finalUrl = reported;
  try {
    await checkUrl(new URL(finalUrl), opts.domain);
  } catch {
    throw new ReadError('left the domain');
  }
  const markdown = data.markdown.slice(0, MAX_MARKDOWN);
  // The same link reader as the plain fetch; a scrape without the HTML has no links, not no page.
  const links = typeof data.rawHtml === 'string' ? linksIn(data.rawHtml, finalUrl) : [];
  return { finalUrl, text: markdownToText(markdown), links };
}
