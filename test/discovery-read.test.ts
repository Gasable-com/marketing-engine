import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnv } from '../src/env.js';
import {
  contactsIn,
  isPublicAddress,
  readSite,
  ReadError,
  setFirecrawlFetch,
  setResolver,
  setTransport,
  type Transport,
} from '../src/modules/discovery/read/index.js';
import { guardedGet } from '../src/modules/discovery/read/fetch.js';
import { firecrawlScrape } from '../src/modules/discovery/read/firecrawl.js';
import { htmlToText, linksIn } from '../src/modules/discovery/read/text.js';

// No database and no network: DNS, the socket and Firecrawl all answer from here.

const DNS: Record<string, string[]> = {
  'example.com': ['93.184.216.34'],
  'www.example.com': ['93.184.216.34'],
  'shop.example.com': ['93.184.216.35'],
  'inside.example.com': ['172.18.0.1'],
  'mixed.example.com': ['93.184.216.34', '10.0.0.5'],
  'other.com': ['93.184.216.40'],
};

type Route = { status?: number; headers?: Record<string, string>; body?: string | AsyncIterable<Buffer> };
let routes: Record<string, Route>;
let connects: { url: string; address: string }[];

const transport: Transport = async ({ url, address }) => {
  connects.push({ url, address });
  const route = routes[url];
  if (!route) return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('nope') };
  const body = route.body ?? '';
  return {
    status: route.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...route.headers },
    body: typeof body === 'string' ? Buffer.from(body) : body,
  };
};

const redirect = (to: string): Route => ({ status: 302, headers: { location: to } });
const page = (body: string): Route => ({ body });

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ReadError) return err.reason;
    throw err;
  }
  throw new Error('expected a ReadError');
}

beforeEach(() => {
  routes = {};
  connects = [];
  setResolver(async (host) => {
    const found = DNS[host];
    if (!found) throw new Error(`ENOTFOUND ${host}`);
    return found;
  });
  setTransport(transport);
  delete process.env.FIRECRAWL_URL;
  resetEnv();
});

afterEach(() => {
  setResolver(null);
  setTransport(null);
  setFirecrawlFetch(null);
  delete process.env.FIRECRAWL_URL;
  resetEnv();
});

describe('address check', () => {
  it('refuses every private, local and reserved range, in every form', () => {
    const refused = [
      '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255',
      '127.0.0.1', '127.8.8.8', '169.254.169.254', '172.16.0.1', '172.18.0.1', '172.31.255.255',
      '192.168.1.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
      '::', '::1', '[::1]', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '::ffff:ac12:1',
      '::ffff:192.168.0.1', '0:0:0:0:0:ffff:7f00:0001', '::127.0.0.1', '64:ff9b::a9fe:a9fe',
      'not an address', '1.2.3', '256.1.1.1',
    ];
    for (const ip of refused) expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('accepts public addresses', () => {
    const allowed = [
      '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1',
      '169.253.1.1', '192.169.0.1', '223.255.255.255', '2001:4860:4860::8888', '2a00:1450::1',
      '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808',
    ];
    for (const ip of allowed) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe('guarded fetch', () => {
  it('never reaches a redirect to the metadata address', async () => {
    routes['https://example.com/'] = redirect('http://169.254.169.254/latest/meta-data/');
    expect(await reason(guardedGet('https://example.com/', { domain: 'example.com' }))).toBe('non-public address');
    expect(connects.map((c) => c.url)).toEqual(['https://example.com/']);
  });

  it('never connects to a host that resolves to a private address', async () => {
    expect(await reason(guardedGet('https://inside.example.com/', { domain: 'example.com' }))).toBe(
      'non-public address',
    );
    expect(await reason(guardedGet('https://mixed.example.com/', { domain: 'example.com' }))).toBe(
      'non-public address',
    );
    expect(connects).toEqual([]);
  });

  it('refuses an IPv4-mapped loopback literal', async () => {
    expect(await reason(guardedGet('http://[::ffff:127.0.0.1]/', { domain: 'example.com' }))).toBe(
      'non-public address',
    );
    expect(connects).toEqual([]);
  });

  it('refuses a redirect off the registrable domain, but follows one within it', async () => {
    routes['https://example.com/'] = redirect('https://www.example.com/home');
    routes['https://www.example.com/home'] = redirect('https://other.com/');
    expect(await reason(guardedGet('https://example.com/', { domain: 'example.com' }))).toBe('left the domain');
    expect(connects.map((c) => c.url)).toEqual(['https://example.com/', 'https://www.example.com/home']);
  });

  it('connects to the address it checked, and refuses non-http schemes', async () => {
    routes['https://shop.example.com/'] = page('<p>hi</p>');
    const res = await guardedGet('https://shop.example.com/', { domain: 'example.com' });
    expect(res).toMatchObject({ finalUrl: 'https://shop.example.com/', status: 200, contentType: 'text/html' });
    expect(res.body).toBe('<p>hi</p>');
    expect(connects).toEqual([{ url: 'https://shop.example.com/', address: '93.184.216.35' }]);
    expect(await reason(guardedGet('file:///etc/passwd', { domain: 'example.com' }))).toBe('not http');
  });

  it('follows at most 3 redirects', async () => {
    routes['https://example.com/'] = redirect('/1');
    routes['https://example.com/1'] = redirect('/2');
    routes['https://example.com/2'] = redirect('/3');
    routes['https://example.com/3'] = page('<p>three hops</p>');
    expect((await guardedGet('https://example.com/', { domain: 'example.com' })).finalUrl).toBe(
      'https://example.com/3',
    );
    routes['https://example.com/3'] = redirect('/4');
    routes['https://example.com/4'] = page('<p>four hops</p>');
    connects = [];
    expect(await reason(guardedGet('https://example.com/', { domain: 'example.com' }))).toBe('too many redirects');
    expect(connects.map((c) => c.url)).not.toContain('https://example.com/4');
  });

  it('stops reading a body past 2 MB', async () => {
    let chunksRead = 0;
    async function* huge(): AsyncIterable<Buffer> {
      for (let i = 0; i < 100; i++) {
        chunksRead++;
        yield Buffer.alloc(64 * 1024, 'a');
      }
    }
    routes['https://example.com/'] = { body: huge() };
    expect(await reason(guardedGet('https://example.com/', { domain: 'example.com' }))).toBe('too large');
    expect(chunksRead).toBeLessThanOrEqual(33);

    routes['https://example.com/'] = { headers: { 'content-length': String(3 * 1024 * 1024) }, body: 'x' };
    expect(await reason(guardedGet('https://example.com/', { domain: 'example.com' }))).toBe('too large');
  });

  it('decodes in the charset a <meta> names when the header names none', async () => {
    const arabic = Buffer.from([0xe3, 0xd5, 0xe4, 0xda]); // مصنع in windows-1256
    routes['https://example.com/'] = {
      headers: { 'content-type': 'text/html' },
      body: (async function* () {
        yield Buffer.concat([Buffer.from('<meta charset="windows-1256"><p>'), arabic, Buffer.from('</p>')]);
      })(),
    };
    expect((await guardedGet('https://example.com/', { domain: 'example.com' })).body).toBe(
      '<meta charset="windows-1256"><p>مصنع</p>',
    );
    routes['https://example.com/'] = {
      headers: { 'content-type': 'text/html' },
      body: (async function* () {
        yield Buffer.concat([
          Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1256"><p>'),
          arabic,
        ]);
      })(),
    };
    expect((await guardedGet('https://example.com/', { domain: 'example.com' })).body).toContain('<p>مصنع');
  });

  it('keeps only page types', async () => {
    routes['https://example.com/a.pdf'] = { headers: { 'content-type': 'application/pdf' }, body: '%PDF' };
    expect(await reason(guardedGet('https://example.com/a.pdf', { domain: 'example.com' }))).toBe('not a page');
  });
});

describe('Firecrawl', () => {
  let scrapes: string[];

  function firecrawl(answer: (url: string) => Response): void {
    process.env.FIRECRAWL_URL = 'http://firecrawl.test:3002';
    resetEnv();
    setFirecrawlFetch(async (input, init) => {
      expect(String(input)).toBe('http://firecrawl.test:3002/v1/scrape');
      const { url } = JSON.parse(String(init?.body)) as { url: string };
      scrapes.push(url);
      return answer(url);
    });
  }
  const scraped = (url: string, markdown: string, links: string[] = []) =>
    Response.json({ success: true, data: { markdown, links, metadata: { url, sourceURL: url, statusCode: 200 } } });

  beforeEach(() => {
    scrapes = [];
  });

  it('refuses a response past 2 MB, and a page with no reported final URL', async () => {
    firecrawl((url) => scraped(url, 'x'.repeat(3 * 1024 * 1024)));
    expect(await reason(firecrawlScrape('https://example.com/', { domain: 'example.com' }))).toBe('firecrawl failed');

    firecrawl(() => Response.json({ success: true, data: { markdown: 'hi', metadata: { statusCode: 200 } } }));
    expect(await reason(firecrawlScrape('https://example.com/', { domain: 'example.com' }))).toBe('firecrawl failed');
  });

  it('reads hostile markdown in well under a second', async () => {
    firecrawl((url) => scraped(url, `${'['.repeat(1_500_000)} [About](/about)`));
    const started = performance.now();
    const read = await firecrawlScrape('https://example.com/', { domain: 'example.com' });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(read?.text.length).toBe(300_000);
  });

  it('is skipped when not configured', async () => {
    expect(await firecrawlScrape('https://example.com/', { domain: 'example.com' })).toBeNull();
  });

  it('discards a page whose final URL left the domain or the public internet', async () => {
    firecrawl(() => scraped('https://other.com/', 'elsewhere'));
    expect(await reason(firecrawlScrape('https://example.com/', { domain: 'example.com' }))).toBe('left the domain');

    firecrawl(() => scraped('https://inside.example.com/', 'internal'));
    expect(await reason(firecrawlScrape('https://example.com/', { domain: 'example.com' }))).toBe('left the domain');

    firecrawl(() => scraped('http://169.254.169.254/latest/meta-data/', 'secrets'));
    const read = await readSite({ url: 'https://example.com/', domain: 'example.com' });
    expect(read.pages).toEqual([]);
    expect(read.failed).toEqual([{ url: 'https://example.com/', reason: 'left the domain' }]);
    expect(connects).toEqual([]);
  });

  it('is never asked for a host that resolves to a private address', async () => {
    firecrawl((url) => scraped(url, 'internal'));
    expect(await reason(firecrawlScrape('https://inside.example.com/', { domain: 'example.com' }))).toBe(
      'non-public address',
    );
    expect(scrapes).toEqual([]);
  });

  it('falls back to the guarded fetch when a scrape fails', async () => {
    firecrawl(() => new Response('boom', { status: 500 }));
    routes['https://example.com/'] = page('<h1>Example Trading</h1><p>Diesel supply</p>');
    const read = await readSite({ url: null, domain: 'example.com' });
    expect(read.pages).toEqual([{ url: 'https://example.com/', text: 'Example Trading\nDiesel supply' }]);
    expect(read).toMatchObject({ firecrawl: 0, fetchFallback: 1, failed: [] });

    firecrawl(() => Response.json({ success: false, error: 'blocked' }));
    expect((await readSite({ url: null, domain: 'example.com' })).fetchFallback).toBe(1);
  });

  it('reads the home page and chosen pages through Firecrawl', async () => {
    firecrawl((url) =>
      url === 'https://example.com/'
        ? scraped(url, 'Home [من نحن](https://example.com/%D9%85%D9%86-%D9%86%D8%AD%D9%86)', [
            'https://example.com/products',
            'https://example.com/%D9%85%D9%86-%D9%86%D8%AD%D9%86',
          ])
        : scraped(url, `page ${url}`),
    );
    const read = await readSite({ url: 'https://example.com/', domain: 'example.com' });
    expect(read.pages.map((p) => p.url)).toEqual([
      'https://example.com/',
      'https://example.com/products',
      'https://example.com/%D9%85%D9%86-%D9%86%D8%AD%D9%86',
    ]);
    expect(read).toMatchObject({ firecrawl: 3, fetchFallback: 0 });
    expect(connects).toEqual([]);
  });
});

describe('which pages are read', () => {
  it('reads home, then products, about and contact, at most 3, same domain only', async () => {
    routes['https://www.example.com/'] = page(`
      <a href="/contact-us">Contact</a>
      <a href="/blog">Blog</a>
      <a href="https://shop.example.com/about">About us</a>
      <a href="/products#top">Our range</a>
      <a href="/products">Products again</a>
      <a href="/catalog">Catalog</a>
      <a href="/">Home</a>
      <a href="https://other.com/products">Partner products</a>
      <a href="/brochure.pdf">Products brochure</a>
      <a href="/%D8%AA%D9%88%D8%A7%D8%B5%D9%84">تواصل معنا</a>`);
    routes['https://www.example.com/products'] = page('<p>products</p>');
    routes['https://shop.example.com/about'] = page('<p>about</p>');
    routes['https://www.example.com/contact-us'] = page('<p>contact</p>');
    const read = await readSite({ url: 'https://www.example.com/?utm=x', domain: 'example.com' });
    expect(read.pages.map((p) => p.url)).toEqual([
      'https://www.example.com/',
      'https://www.example.com/products',
      'https://shop.example.com/about',
      'https://www.example.com/contact-us',
    ]);
    expect(connects.some((c) => c.url.includes('other.com'))).toBe(false);
    expect(read.failed).toEqual([]);
  });

  it('matches Arabic link text, and fills spare slots with more of the earliest kind', async () => {
    routes['https://example.com/'] = page(`
      <a href="/p/1">منتجات</a><a href="/p/2">المنتجات</a><a href="/x">اتصل بنا</a><a href="/y">خدمات</a>`);
    const read = await readSite({ url: null, domain: 'example.com' });
    expect(connects.map((c) => c.url)).toEqual([
      'https://example.com/',
      'https://example.com/p/1',
      'https://example.com/x',
      'https://example.com/p/2',
    ]);
    expect(read.failed.map((f) => f.reason)).toEqual(['http 404', 'http 404', 'http 404']);
  });

  it('starts at the domain root when the URL is elsewhere, and never reads a shared host', async () => {
    routes['https://example.com/'] = page('<p>root</p>');
    const read = await readSite({ url: 'https://other.com/x', domain: 'example.com' });
    expect(read.pages.map((p) => p.url)).toEqual(['https://example.com/']);

    connects = [];
    const shared = await readSite({ url: 'https://salla.sa/shop', domain: 'salla.sa' });
    expect(shared.pages).toEqual([]);
    expect(shared.failed[0]?.reason).toBe('shared host');
    expect(connects).toEqual([]);
  });

  it('caps each page at 20 000 characters and a candidate at 40 000', async () => {
    const links = '<a href="/products">p</a><a href="/about">a</a><a href="/contact">c</a>';
    routes['https://example.com/'] = page(`${links}<p>${'h'.repeat(25_000)}</p>`);
    routes['https://example.com/products'] = page(`<p>${'p'.repeat(15_000)}</p>`);
    routes['https://example.com/about'] = page(`<p>${'a'.repeat(15_000)}</p>`);
    routes['https://example.com/contact'] = page(`<p>${'c'.repeat(15_000)}</p>`);
    const read = await readSite({ url: null, domain: 'example.com' });
    expect(read.pages.map((p) => p.text.length)).toEqual([20_000, 15_000, 5_000]);
    expect(read.pages.reduce((n, p) => n + p.text.length, 0)).toBe(40_000);
    // Reading stops once the candidate is full.
    expect(connects.map((c) => c.url)).not.toContain('https://example.com/contact');
  });
});

describe('html to text', () => {
  it('decodes typographic and bidi entities, and never leaves an entity name in the text', () => {
    const html =
      '<p>Al Falah&rsquo;s plant &ndash; high&#8209;strength &laquo;C60&raquo;&hellip; &copy; &unknown; a&nbsp b</p>' +
      '<img alt="a > b" src="x.png"> after <a data-href="#" href="tel:+966501111111">call</a>';
    expect(htmlToText(html)).toBe(
      'Al Falah’s plant – high\u2011strength «C60»… © a b\nafter tel:+966501111111 call',
    );
  });

  it('turns a small Arabic and English page into lines of text', () => {
    const html = `<!doctype html><html><head><title>t</title><style>p{}</style></head><body>
      <script>var secret = 1;</script><noscript>enable js</noscript><svg><text>logo</text></svg>
      <h1>مصنع الفلاح &amp; Sons</h1>
      <div>Ready-mix&nbsp;concrete &lt;C60&gt;</div><p>سجل تجاري: &#1633;&#x0660;10</p>
      <ul><li>Riyadh</li><li>الرياض</li></ul>Line<br/>break
      <a href="https://wa.me/966501111111">WhatsApp</a>
    </body></html>`;
    expect(htmlToText(html)).toBe(
      'مصنع الفلاح & Sons\nReady-mix concrete <C60>\nسجل تجاري: ١٠10\nRiyadh\nالرياض\nLine\nbreak https://wa.me/966501111111 WhatsApp',
    );
  });
});

describe('hostile markup', () => {
  it('converts 2 MB of unclosed tags in well under a second', () => {
    const size = 2 * 1024 * 1024;
    const bodies = [
      '<'.repeat(size),
      '<svg'.repeat(size / 4),
      '<!--'.repeat(size / 4),
      '<a href=x>'.repeat(size / 10),
      '<a title="'.repeat(size / 10),
      ('<a href=mailto:' + 'x'.repeat(1990)).repeat(size / 2005),
      '<head'.repeat(size / 5),
    ];
    for (const body of bodies) {
      const started = performance.now();
      htmlToText(body);
      linksIn(body, 'https://example.com/');
      expect(performance.now() - started, body.slice(0, 20)).toBeLessThan(1000);
    }
  });

  it('finds emails in long runs of address characters quickly', () => {
    const started = performance.now();
    for (const text of ['a'.repeat(40_000), 'a.'.repeat(20_000), 'a@'.repeat(20_000)]) {
      contactsIn(text, { country: 'SA' });
    }
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('links', () => {
  it('resolves against <base href>, reads href not data-href, and skips comments and scripts', () => {
    const html = `<head><base href="https://example.com/en/"></head>
      <a href="products">P</a>
      <a data-href="#" href="/about">About</a>
      <!-- <a href="/old-products">Products</a> -->
      <script>var s = "<a href='/script-link'>x</a>";</script>
      <a title="a > b" href="/contact"><b>Contact</b> us</a>`;
    expect(linksIn(html, 'https://example.com/')).toEqual([
      { url: 'https://example.com/en/products', text: 'P' },
      { url: 'https://example.com/about', text: 'About' },
      { url: 'https://example.com/contact', text: 'Contact us' },
    ]);
  });
});

describe('contacts by pattern', () => {
  it('finds Saudi phones, emails and WhatsApp numbers', () => {
    const text = `Call 050 111 1111 or +966 50 222 2222, office 013 555 5555.
      Mail Sales@Example.com, sales@example.com, logo@2x.png.
      https://wa.me/966503333333 and https://api.whatsapp.com/send?phone=966504444444&text=hi`;
    const found = contactsIn(text, { country: 'SA' });
    expect(found.phones).toEqual([
      '+966501111111',
      '+966502222222',
      '+966135555555',
      '+966503333333',
      '+966504444444',
    ]);
    expect(found.emails).toEqual(['sales@example.com']);
    expect(found.whatsapp).toEqual(['+966503333333', '+966504444444']);
    expect(found.crs).toEqual([]);
  });

  it('never takes a national-address code, a link target or a SKU for a phone', () => {
    const text = `Riyadh 12271-6435. Hail 55421-1234. الرياض ١٢٢٧١-٦٤٣٥. P.O. Box 0551234567.
      [Diesel](https://example.com/product/112223333) ![x](/img/0551234567.png)
      https://example.com/watch?v=0551234567 SKU 553331234, Item #112223333.
      [Call us](tel:0501111111) Hotline 920012345.`;
    expect(contactsIn(text, { country: 'SA' }).phones).toEqual(['+966501111111', '+966920012345']);
  });

  it('reads every number of a list', () => {
    expect(contactsIn('Tel: 011 222 3333, 050 111 1111', { country: 'SA' }).phones).toEqual([
      '+966112223333',
      '+966501111111',
    ]);
    expect(contactsIn('0112223333، 0501111111; 0135555555 | 0502222222 / 0503333333', { country: 'SA' }).phones).toEqual(
      ['+966112223333', '+966501111111', '+966135555555', '+966502222222', '+966503333333'],
    );
    expect(contactsIn('0501111111-0552222222', { country: 'SA' }).phones).toEqual(['+966501111111', '+966552222222']);
    expect(contactsIn('+971 4 123 4567, 050 987 6543', { country: 'AE' }).phones).toEqual([
      '+97141234567',
      '+971509876543',
    ]);
  });

  it('finds a CR next to its keyword, in Arabic-Indic digits, only for SA', () => {
    expect(contactsIn('CR1010123456', { country: 'SA' }).crs).toEqual(['1010123456']);
    expect(contactsIn('Commercial Register No. 1010123456', { country: 'SA' }).crs).toEqual(['1010123456']);
    expect(contactsIn('CRM 1010123456', { country: 'SA' }).crs).toEqual([]);
    const text = 'مصنع الفلاح — سجل تجاري رقم ١٠١٠١٢٣٤٥٦ — الرياض';
    expect(contactsIn(text, { country: 'SA' }).crs).toEqual(['1010123456']);
    expect(contactsIn('C.R. No. 4030111222', { country: 'SA' }).crs).toEqual(['4030111222']);
    expect(contactsIn(text, { country: 'AE' }).crs).toEqual([]);
  });

  it('ignores a 10-digit number that is not next to a CR keyword', () => {
    const text = `Order reference 1010123456 is ready. ${'Thank you for your business. '.repeat(3)} CR pending.`;
    expect(contactsIn(text, { country: 'SA' }).crs).toEqual([]);
    expect(contactsIn('Invoice 6010123456 CR 1010', { country: 'SA' }).crs).toEqual([]);
  });
});

describe('markdown from Firecrawl', () => {
  it('reads as plain text, keeping link text and contact targets', async () => {
    const { markdownToText } = await import('../src/modules/discovery/read/text.js');
    const text = markdownToText(
      '# Pool chemicals\n\nAvailable in **tablets and granules**, *easy* to dose.\n\n' +
        '- [Calcium Hypochlorite Granules](https://x.test/cal-hypo/)\n' +
        '- Call [+966 50 111 1111](tel:+966501111111) or [WhatsApp](https://wa.me/966501111111)\n' +
        '| Grade | 70% |\n![logo](https://x.test/l.png)\nsnake_case_word stays.',
    );
    expect(text).toContain('Available in tablets and granules, easy to dose.');
    expect(text).toContain('Calcium Hypochlorite Granules');
    expect(text).not.toMatch(/\*\*|\]\(|^#/m);
    expect(text).toContain('+966501111111');
    expect(text).toContain('https://wa.me/966501111111');
    expect(text).toContain('snake_case_word stays.');
  });

  it('stays fast on hostile markdown', async () => {
    const { markdownToText } = await import('../src/modules/discovery/read/text.js');
    const started = Date.now();
    markdownToText('['.repeat(1_000_000) + '*'.repeat(500_000) + '_'.repeat(500_000) + '`'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
