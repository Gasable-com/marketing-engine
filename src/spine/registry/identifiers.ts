import { env } from '../../env.js';
import { normalize } from '../contacts/normalize.js';

export const IDENTIFIER_TYPES = ['cr', 'vat', 'domain', 'phone', 'email', 'gmaps'] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/**
 * Strong identifiers belong to exactly one company, so two records sharing one
 * are the same company and get merged. Weak ones link but never merge: a phone
 * number or a shared mailbox moves between companies over time. A Google Maps
 * place id names one place, so it is strong.
 */
export const STRONG_TYPES: readonly IdentifierType[] = ['cr', 'vat', 'domain', 'gmaps'];

export function isStrong(type: IdentifierType): boolean {
  return STRONG_TYPES.includes(type);
}

/** Domains that identify a mailbox provider, not a company. */
const FREE_MAIL = new Set([
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com',
  'icloud.com',
  'live.com',
  'msn.com',
  'protonmail.com',
]);

/**
 * Registrable domains that host many companies: shop builders, social
 * networks, link pages and free site hosts. A URL on one of them says where a
 * company has a page, not which company it is, so it never identifies one.
 */
export const SHARED_HOSTS: ReadonlySet<string> = new Set([
  'salla.sa',
  'salla.com',
  'zid.store',
  'zid.sa',
  'instagram.com',
  'facebook.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'snapchat.com',
  'youtube.com',
  'linktr.ee',
  'wa.me',
  'whatsapp.com',
  't.me',
  'business.site',
  'wixsite.com',
  'blogspot.com',
  'wordpress.com',
  'google.com',
  'myshopify.com',
  'manus.space',
  'vercel.app',
  'netlify.app',
  'github.io',
  'haraj.com.sa',
  'opensooq.com',
]);

/**
 * Public suffixes of two labels, kept short and explicit rather than pulling
 * in the whole public suffix list. Every other suffix counts as one label.
 */
const TWO_LEVEL_SUFFIXES = new Set([
  'com.sa',
  'net.sa',
  'org.sa',
  'gov.sa',
  'edu.sa',
  'med.sa',
  'sch.sa',
  'co.ae',
  'com.ae',
  'net.ae',
  'org.ae',
  'gov.ae',
  'ac.ae',
  'com.eg',
  'com.tr',
  'co.uk',
  'com.cn',
  'co.in',
]);

/** The marketplace's own domain identifies the marketplace, not a counterparty. */
function ownDomain(): string | undefined {
  const own = env().PLATFORM_DOMAIN?.trim();
  return own ? (normalizeDomain(own) ?? undefined) : undefined;
}

export function isSharedHost(domain: string): boolean {
  return SHARED_HOSTS.has(domain);
}

export function isUselessDomain(domain: string): boolean {
  return FREE_MAIL.has(domain) || isSharedHost(domain) || domain === ownDomain();
}

export type RawIdentifier = { type: string; value: string };
export type Identifier = { type: IdentifierType; value: string };

export type NormalizedIdentifiers = {
  identifiers: Identifier[];
  /** Inputs that could not be made into an identifier, with why. */
  rejected: { type: string; value: string; reason: string }[];
};

/**
 * Turn raw identifiers into the canonical forms the registry stores and
 * matches on. Pure: no database, no network. An email also yields its domain,
 * which is the strong identifier hiding inside a weak one.
 */
export function normalizeIdentifiers(
  raw: RawIdentifier[],
  opts: { defaultCountry?: string | undefined } = {},
): NormalizedIdentifiers {
  const identifiers: Identifier[] = [];
  const rejected: NormalizedIdentifiers['rejected'] = [];

  const add = (type: IdentifierType, value: string) => {
    if (!identifiers.some((i) => i.type === type && i.value === value)) {
      identifiers.push({ type, value });
    }
  };

  for (const entry of raw) {
    const type = entry.type?.trim().toLowerCase();
    const value = entry.value?.trim() ?? '';
    if (!value) continue;

    switch (type) {
      case 'cr':
      case 'vat': {
        const digits = value.replace(/\D/g, '');
        if (!digits) {
          rejected.push({ type, value, reason: 'no digits' });
          break;
        }
        add(type, digits);
        break;
      }

      case 'domain': {
        const domain = normalizeDomain(value);
        if (!domain) {
          rejected.push({ type, value, reason: 'not a domain' });
          break;
        }
        // The caller's URL is not lost: upsert keeps every rejected input,
        // value and all, in the source's data.
        if (isSharedHost(domain)) {
          rejected.push({ type, value, reason: 'shared host' });
          break;
        }
        if (isUselessDomain(domain)) {
          rejected.push({ type, value, reason: 'identifies nobody' });
          break;
        }
        add('domain', domain);
        break;
      }

      case 'phone': {
        try {
          const contact = normalize({
            channel: 'sms',
            address: value,
            ...(opts.defaultCountry ? { defaultCountry: opts.defaultCountry } : {}),
          });
          add('phone', contact.address);
        } catch {
          rejected.push({ type, value, reason: 'not a valid phone number' });
        }
        break;
      }

      case 'email': {
        const email = value.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          rejected.push({ type, value, reason: 'not a valid email address' });
          break;
        }
        add('email', email);

        // A mailbox at a free-mail provider or a shared host says nothing
        // about the company, so it yields no domain.
        const domain = normalizeDomain(email.slice(email.indexOf('@') + 1));
        if (domain && !isUselessDomain(domain)) add('domain', domain);
        break;
      }

      case 'gmaps': {
        // A place id or cid exactly as Google gave it: case matters.
        if (!/^[A-Za-z0-9:_-]{1,200}$/.test(value)) {
          rejected.push({ type, value, reason: 'not a Google Maps place id' });
          break;
        }
        add('gmaps', value);
        break;
      }

      default:
        rejected.push({ type: type ?? '', value, reason: 'unknown identifier type' });
    }
  }

  return { identifiers, rejected };
}

/**
 * The registrable domain: scheme, credentials, port and path stripped, then
 * every subdomain down to the label before the public suffix. A shop's
 * `www.diesel.example.com` and its mail's `example.com` are one company.
 */
export function normalizeDomain(value: string): string | null {
  let host = value.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.replace(/^[^/@]*@/, '');
  host = host.split(/[/?#]/)[0] ?? '';
  host = host.split(':')[0] ?? '';
  host = host.replace(/\.$/, '');

  if (!host || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  // An address is not a domain, and its last two numbers are not one either.
  if (/^\d+(\.\d+)+$/.test(host)) return null;

  const labels = host.split('.');
  const keep = TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  // A bare public suffix such as `com.sa` names nobody.
  if (labels.length < keep) return null;
  return labels.slice(-keep).join('.');
}
