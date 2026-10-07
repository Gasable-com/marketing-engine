/**
 * HTML to text in a few lines, with no parser: drop what is never read, break
 * lines where blocks end, strip the tags, decode the common entities. The
 * target of a mailto:, tel: or WhatsApp link is kept as text, since that is
 * often the only place a page gives it.
 *
 * A page is hostile input, so every scan here is linear: no pattern can run to
 * the end of the page from each `<` it starts at.
 */

/** Markup kept after the never-read blocks are gone; only 20 000 characters of text are kept per page. */
const MAX_HTML = 300_000;

export function htmlToText(html: string): string {
  const text = readable(html)
    // Source line breaks are only whitespace; lines come from the markup.
    .replace(/\s+/g, ' ')
    .replace(A_TAG, (tag: string) => {
      const href = hrefOf(tag);
      return href && KEPT_HREF.test(href) ? ` ${href} ` : tag;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|ul|ol|table)\s*>/gi, '\n')
    // A quoted attribute value may hold '>'; nothing in a tag crosses a '<'.
    .replace(TAG, ' ')
    .replace(/<[^<>]*>/g, ' ');
  return decodeEntities(text)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n\s*/g, '\n')
    .trim();
}

/** A tag, whose quoted attribute values may hold '>'. Nothing in a tag crosses a '<'. */
const TAG = /<(?:[^<>"']|"[^<"]{0,2000}"|'[^<']{0,2000}'){0,4000}>/g;
const A_TAG = /<a\s(?:[^<>"']|"[^<"]{0,2000}"|'[^<']{0,2000}'){0,4000}>/gi;
const KEPT_HREF = /^(?:mailto:|tel:|https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/)/i;

/** The raw href of one tag: the first `href=` after whitespace, so never `data-href`. */
function hrefOf(tag: string): string | null {
  const m = /\shref\s*=\s*/i.exec(tag);
  if (!m) return null;
  const at = m.index + m[0].length;
  const quote = tag[at];
  if (quote === '"' || quote === "'") {
    const end = tag.indexOf(quote, at + 1);
    return end < 0 ? null : tag.slice(at + 1, end).trim();
  }
  const end = tag.slice(at).search(/[\s>]/);
  return tag.slice(at, end < 0 ? tag.length : at + end);
}

const DROPPED = /<!--|<(script|style|noscript|svg|head|template)\b/gi;
/** An unclosed script or style hides the rest of the page; an unclosed head or svg hides nothing. */
const TO_THE_END = new Set(['script', 'style']);

/**
 * The page without comments and the blocks that are never read, cut to
 * MAX_HTML. One pass: each closing tag is looked for once, and a name with no
 * closing tag left is never looked for again.
 */
function readable(html: string): string {
  const lower = html.toLowerCase();
  const unclosed = new Set<string>();
  const parts: string[] = [];
  let from = 0;
  DROPPED.lastIndex = 0;
  for (let m = DROPPED.exec(html); m; m = DROPPED.exec(html)) {
    const name = m[1]?.toLowerCase();
    const close = name ? `</${name}` : '-->';
    let end = -1;
    if (!unclosed.has(close)) {
      end = name ? closingTag(lower, close, m.index + m[0].length) : lower.indexOf(close, m.index + 4);
      if (end < 0) unclosed.add(close);
    }
    if (end < 0) {
      if (!name || TO_THE_END.has(name)) {
        parts.push(html.slice(from, m.index));
        from = html.length;
        break;
      }
      continue; // the open tag alone; the tag stripping removes it
    }
    parts.push(html.slice(from, m.index), ' ');
    from = name ? end : end + 3;
    DROPPED.lastIndex = from;
  }
  parts.push(html.slice(from));
  return parts.join('').slice(0, MAX_HTML);
}

/** The index just past `</name ... >`, or -1. */
function closingTag(lower: string, close: string, from: number): number {
  for (let at = lower.indexOf(close, from); at >= 0; at = lower.indexOf(close, at + 1)) {
    let i = at + close.length;
    while (i < lower.length && /\s/.test(lower[i]!)) i++;
    if (lower[i] === '>') return i + 1;
  }
  return -1;
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', plusmn: '±',
  sect: '§', para: '¶', euro: '€', pound: '£', cent: '¢', yen: '¥',
  rlm: '\u200f', lrm: '\u200e', zwnj: '\u200c', zwj: '\u200d', shy: '\u00ad',
};
/** Entities a browser still reads without their semicolon. */
const LEGACY = /&(amp|lt|gt|quot|nbsp|copy|reg)(?![a-z0-9;])/gi;

function decodeEntities(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z][a-z0-9]{1,31});/gi, (_, code: string) => {
      // An entity not known here is a space, never its name in the text.
      if (code[0] !== '#') return NAMED[code.toLowerCase()] ?? ' ';
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
    })
    .replace(LEGACY, (_, name: string) => NAMED[name.toLowerCase()] ?? ' ');
}

export type Link = { url: string; text: string };

/** Where a link's text ends: its closing tag, or the next link. */
const ANCHOR_END = /<\/?a[\s>/]/gi;
const BASE = /<base\s(?:[^<>"']|"[^<"]{0,2000}"|'[^<']{0,2000}'){0,4000}>/i;

/**
 * Every `<a href>` on a page as an absolute http(s) URL, fragment dropped, with
 * its text. Relative links resolve against the page's `<base href>` when it
 * has one; links in comments and scripts are not links.
 */
export function linksIn(html: string, pageUrl: string): Link[] {
  const page = readable(html);
  let baseUrl = pageUrl;
  // The base lives in the head, which readable() drops.
  const baseHref = hrefOf(BASE.exec(html.slice(0, MAX_HTML))?.[0] ?? '');
  if (baseHref) {
    try {
      baseUrl = new URL(decodeEntities(baseHref), pageUrl).href;
    } catch {
      // a broken base: resolve against the page
    }
  }

  const links: Link[] = [];
  let end: number | null = null; // where the current link's text ends; -1 once none is left
  // Its own instance: htmlToText below runs A_TAG through replace, which resets lastIndex.
  const anchors = new RegExp(A_TAG.source, 'gi');
  for (let m = anchors.exec(page); m; m = anchors.exec(page)) {
    const bodyStart = m.index + m[0].length;
    if (end === null || (end >= 0 && end < bodyStart)) {
      ANCHOR_END.lastIndex = bodyStart;
      end = ANCHOR_END.exec(page)?.index ?? -1;
    }
    const bodyEnd = end < 0 ? page.length : end;

    const raw = hrefOf(m[0]);
    if (raw === null) continue;
    const href = decodeEntities(raw.trim());
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    const text = htmlToText(page.slice(bodyStart, Math.min(bodyEnd, bodyStart + 2000))).replace(/\s+/g, ' ');
    links.push({ url: url.href, text });
  }
  return links;
}

/**
 * Firecrawl's markdown as plain text, so quotes Claude copies carry no `**`,
 * `#` or `[text](url)` and match what a reader sees. Link text stays; a
 * contact link's target stays too (`tel:`, `mailto:`, WhatsApp), since that
 * is often the only place the number is written. Every pattern is bounded
 * and the input is capped, so nothing here can run away.
 */
export function markdownToText(markdown: string): string {
  const contact = /^(tel:|mailto:|https?:\/\/(wa\.me|api\.whatsapp\.com)\/)/i;
  return markdown
    .slice(0, MAX_HTML)
    .replace(/!\[([^[\]\n]{0,500})\]\([^)\s]{1,2000}(?:\s+"[^"\n]{0,300}")?\)/g, '$1')
    .replace(/\[([^[\]\n]{0,500})\]\(([^)\s]{1,2000})(?:\s+"[^"\n]{0,300}")?\)/g, (_m, text: string, url: string) =>
      contact.test(url) ? `${text} ${url.replace(/^(tel:|mailto:)/i, '')}` : text,
    )
    .replace(/<(https?:\/\/[^>\s]{1,2000})>/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]{0,8}(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/(\*\*|__)(?=\S)([^*_\n]{1,1000}?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]{1,500}?)[*_](?=[^\w*]|$)/gm, '$1$2')
    .replace(/`{1,3}([^`\n]{0,1000})`{1,3}/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
