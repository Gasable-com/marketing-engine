import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Whether an address is on the public internet. Everything a page could use
 * to reach this host, its network or the cloud's metadata service is refused:
 * private, loopback, link-local, carrier NAT, multicast and reserved ranges,
 * and the IPv6 forms that embed an IPv4 address. Anything unparseable is
 * refused too.
 */
export function isPublicAddress(ip: string): boolean {
  const bare = unbracket(ip).split('%')[0] ?? '';
  const v4 = parseV4(bare);
  if (v4) return isPublicV4(v4);
  const v6 = parseV6(bare);
  if (!v6) return false;
  return isPublicV6(v6);
}

function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

function isPublicV4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return a < 224;
}

/** Sixteen bytes, or null. Accepts `::`, a dotted IPv4 tail and hex groups. */
function parseV6(ip: string): number[] | null {
  if (!ip.includes(':')) return null;
  let text = ip.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseV4(last);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string | undefined) => (s ? s.split(':') : []);
  const head = groups(halves[0]);
  const rest = groups(halves[1]);
  let all = head;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    all = [...head, ...Array<string>(fill).fill('0'), ...rest];
  }
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

function isPublicV6(b: number[]): boolean {
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::/96 covers :: and ::1 and the deprecated IPv4-compatible form.
  if (zeros(0, 12)) return false;
  // ::ffff:a.b.c.d, IPv4-mapped.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicV4(b.slice(12));
  // 64:ff9b::/96, NAT64: the IPv4 address it reaches decides.
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) {
    return isPublicV4(b.slice(12));
  }
  const first = b[0] ?? 0;
  if ((first & 0xfe) === 0xfc) return false; // fc00::/7
  if (first === 0xfe && ((b[1] ?? 0) & 0xc0) === 0x80) return false; // fe80::/10
  if (first === 0xff) return false; // ff00::/8
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

let resolver: Resolver = systemResolver;

/** Tests answer DNS from a stub; nothing else replaces it. */
export function setResolver(fn: Resolver | null): void {
  resolver = fn ?? systemResolver;
}

/** Every address a host resolves to. An IP literal is its own only address. */
export async function resolveHost(host: string): Promise<string[]> {
  const bare = unbracket(host);
  if (isIP(bare)) return [bare];
  return resolver(bare);
}
