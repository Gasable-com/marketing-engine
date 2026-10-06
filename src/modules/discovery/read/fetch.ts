import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { normalizeDomain } from '../../../spine/registry/identifiers.js';
import { isPublicAddress, resolveHost } from './address.js';

/**
 * Why a page was not read. The reason is a short fixed phrase, never anything
 * from the page, so it can go into counts and candidate reasons as it is.
 */
export class ReadError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const PAGE_TYPES = new Set(['text/html', 'text/plain', 'application/xhtml+xml']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type TransportRequest = {
  url: string;
  /** The checked address to connect to; the host is never looked up again. */
  address: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
};
export type TransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer> | Buffer;
};
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** node:http(s) pinned to the checked address, with SNI and Host from the URL. */
const socketTransport: Transport = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(address) === 6 ? 6 : 4;
    const pinned = ((_name, options, callback) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    }) as LookupFunction;
    const request = (u.protocol === 'https:' ? https : http).request(
      {
        protocol: u.protocol,
        hostname: host,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { ...headers, host: u.host },
        lookup: pinned,
        agent: false,
        ...(u.protocol === 'https:' && !isIP(host) ? { servername: host } : {}),
        ...(signal ? { signal } : {}),
      },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }),
    );
    request.on('error', reject);
    request.end();
  });

let transport: Transport = socketTransport;

/** Tests replace the socket; DNS and every check still run. */
export function setTransport(fn: Transport | null): void {
  transport = fn ?? socketTransport;
}

/**
 * The address to connect to for a URL, after every check: http(s) only, on the
 * candidate's registrable domain, and every address the host resolves to
 * public. The host is resolved once, here.
 */
export async function checkUrl(url: URL, domain: string): Promise<string> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ReadError('not http');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    throw new ReadError(isPublicAddress(host) ? 'left the domain' : 'non-public address');
  }
  if (normalizeDomain(host) !== domain) throw new ReadError('left the domain');
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw new ReadError('no address');
  }
  if (!addresses.length) throw new ReadError('no address');
  if (addresses.some((a) => !isPublicAddress(a))) throw new ReadError('non-public address');
  return addresses[0] as string;
}

export type Fetched = { finalUrl: string; status: number; contentType: string; body: string };

/**
 * GET one page of a candidate's site, guarded: redirects by hand, every hop
 * checked, the body streamed and cut at 2 MB, the whole read within 15 s.
 */
export async function guardedGet(url: string, opts: { domain: string }): Promise<Fetched> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ReadError('timeout'));
    }, TIMEOUT_MS);
  });
  const work = get(url, opts.domain, controller.signal);
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function get(url: string, domain: string, signal: AbortSignal): Promise<Fetched> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new ReadError('bad url');
  }
  for (let hop = 0; ; hop++) {
    const address = await checkUrl(current, domain);
    let res: TransportResponse;
    try {
      res = await transport({
        url: current.href,
        address,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; marketing-engine discovery)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        },
        signal,
      });
    } catch {
      throw new ReadError(signal.aborted ? 'timeout' : 'connection failed');
    }

    const location = header(res.headers, 'location');
    if (REDIRECTS.has(res.status) && location) {
      discard(res.body);
      if (hop >= MAX_REDIRECTS) throw new ReadError('too many redirects');
      try {
        current = new URL(location, current);
      } catch {
        throw new ReadError('bad redirect');
      }
      current.hash = '';
      continue;
    }

    const contentType = (header(res.headers, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!PAGE_TYPES.has(contentType)) {
      discard(res.body);
      throw new ReadError('not a page');
    }
    if (Number(header(res.headers, 'content-length') ?? 0) > MAX_BYTES) {
      discard(res.body);
      throw new ReadError('too large');
    }
    const bytes = await readCapped(res.body);
    return {
      finalUrl: current.href,
      status: res.status,
      contentType,
      body: decode(bytes, header(res.headers, 'content-type')),
    };
  }
}

function header(headers: TransportResponse['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** A body read as a stream and refused past MAX_BYTES. */
export async function readCapped(body: AsyncIterable<Uint8Array> | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_BYTES) throw new ReadError('too large');
    return body;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Throwing out of the loop ends the iterator, which destroys a socket stream.
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new ReadError('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function discard(body: TransportResponse['body']): void {
  if (Buffer.isBuffer(body)) return;
  const stream = body as { destroy?: () => void };
  if (typeof stream.destroy === 'function') stream.destroy();
  else void body[Symbol.asyncIterator]().return?.();
}

/**
 * The page as text, in the charset the header names, else the one a <meta> in
 * the first kilobyte names (older Arabic sites declare windows-1256 only
 * there), else UTF-8.
 */
function decode(bytes: Buffer, contentType: string | undefined): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ?? metaCharset(bytes);
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function metaCharset(bytes: Buffer): string | undefined {
  const head = bytes.subarray(0, 1024).toString('latin1');
  return /<meta\s[^<>]{0,300}?charset\s*=\s*["']?([\w-]{1,40})/i.exec(head)?.[1];
}
