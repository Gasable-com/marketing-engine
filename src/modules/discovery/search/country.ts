import { isSupportedCountry } from 'libphonenumber-js';
import { z } from 'zod';
import { asOwner, withTenant, type Tx } from '../../../db/client.js';
import { foldText } from '../../../spine/registry/index.js';
import type { CountryAnswer } from '../prompts.js';
import {
  allValues,
  applyDocument,
  decide,
  evaluate,
  regionRows,
  saveRegionValue,
} from '../../../spine/rules/index.js';

/**
 * How to search one country, from its `discovery.country` rule row: Google's
 * `gl`, the suffix to add in each language, its cities in both scripts, and
 * its own names. Country specifics live in rule rows, never here.
 */
export type CountrySettings = {
  gl: string;
  languages: string[];
  suffix: Record<string, string>;
  names: string[];
  cities: Record<string, string>[];
};

const KIND = 'discovery.country';

/** An ISO 639-1 language code, as Serper's `hl` takes it. */
export const LANG = /^[a-z]{2}$/;

/** A real ISO 3166-1 alpha-2 country code, upper case: `XX` is not one. */
export const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'an ISO 3166-1 alpha-2 code')
  .refine((code) => isSupportedCountry(code), 'a country code that exists');

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** A country's English name, for prompts and the operator. */
export function countryName(code: string): string {
  return regionNames.of(code) ?? code;
}

/**
 * A country's settings as the operator or Claude gives them, checked before
 * they become a rule row: every language a code, a suffix and city names only
 * in those languages, every city named in at least one of them.
 */
export const CountrySettingsInput = z
  .object({
    gl: z.string().trim().toLowerCase().regex(LANG, 'a two-letter Google country code'),
    languages: z.array(z.string().trim().toLowerCase().regex(LANG)).min(1).max(4),
    suffix: z.record(z.string().regex(LANG), z.string().trim().min(1).max(100)),
    names: z.array(z.string().trim().min(1).max(100)).max(30),
    cities: z.array(z.record(z.string().regex(/^[a-z]{2,3}$/), z.string().trim().min(1).max(100))).max(20),
  })
  .superRefine((s, ctx) => {
    if (new Set(s.languages).size !== s.languages.length) {
      ctx.addIssue({ code: 'custom', path: ['languages'], message: 'each language once' });
    }
    for (const lang of Object.keys(s.suffix)) {
      if (!s.languages.includes(lang)) {
        ctx.addIssue({ code: 'custom', path: ['suffix', lang], message: 'not one of the languages' });
      }
    }
    s.cities.forEach((city, i) => {
      if (!s.languages.some((lang) => city[lang])) {
        ctx.addIssue({ code: 'custom', path: ['cities', i], message: 'named in none of the languages' });
      }
    });
  });

export async function countrySettings(tenantId: string, country: string): Promise<CountrySettings> {
  const { value } = await withTenant(tenantId, (tx) =>
    decide<Partial<CountrySettings>>(tx, {
      kind: KIND,
      tenantId,
      region: country,
      context: { country },
    }),
  );
  return {
    gl: typeof value?.gl === 'string' ? value.gl : country.toLowerCase(),
    languages: Array.isArray(value?.languages) ? value.languages : ['en'],
    suffix: value?.suffix && typeof value.suffix === 'object' ? value.suffix : {},
    names: Array.isArray(value?.names) ? value.names : [],
    cities: Array.isArray(value?.cities) ? value.cities : [],
  };
}

/**
 * Claude's description of a country as the settings a row holds. English is
 * always one of the languages, as it is for SA and AE; a suffix or city name
 * in a language not listed is dropped, and so is a city left with no name.
 */
export function settingsFromAnswer(country: string, answer: CountryAnswer): CountrySettings {
  const languages = [...new Set([...answer.languages, 'en'])];
  const listed = (lang: string) => languages.includes(lang);
  const suffix: Record<string, string> = {};
  for (const s of answer.suffix) if (listed(s.lang) && !suffix[s.lang]) suffix[s.lang] = s.name;
  const cities = answer.cities
    .map((c) => Object.fromEntries(c.names.filter((n) => listed(n.lang)).map((n) => [n.lang, n.name])))
    .filter((c) => Object.keys(c).length > 0);
  const names = [...new Set([...answer.names, ...Object.values(suffix)])];
  return CountrySettingsInput.parse({ gl: country.toLowerCase(), languages, suffix, names, cities });
}

/** Whether a country has a discovery.country row the tenant would search with. */
export async function hasCountrySettings(tenantId: string, country: string): Promise<boolean> {
  const { value } = await withTenant(tenantId, (tx) =>
    decide<unknown>(tx, { kind: KIND, tenantId, region: country, context: { country } }),
  );
  return value !== null;
}

/**
 * Save a country's settings as its region row. `by` names who made them, in
 * the rule's name. With `replace` false a row that already exists (another
 * job made it first) is kept, and false comes back.
 *
 * On the caller's transaction, which must hold the owning role: region rows
 * are the platform's. `saveMadeSettings` wraps it for a tenant's job.
 */
export async function saveCountrySettings(
  tx: Tx,
  country: string,
  settings: CountrySettings,
  opts: { by: 'Claude' | 'operator'; replace: boolean; timezone?: string | undefined },
): Promise<boolean> {
  const row = await saveRegionValue(tx, {
    kind: KIND,
    region: country,
    timezone: opts.timezone && isTimeZone(opts.timezone) ? opts.timezone : 'UTC',
    name: `Search ${countryName(country)} (${opts.by === 'Claude' ? 'made by Claude' : 'set by operator'})`,
    value: settings,
    replace: opts.replace,
  });
  return row !== null;
}

/** Settings Claude made during a tenant's job, saved as the platform. */
export async function saveMadeSettings(
  tenantId: string,
  country: string,
  settings: CountrySettings,
  timezone?: string,
): Promise<boolean> {
  return withTenant(tenantId, (tx) =>
    asOwner(tx, () => saveCountrySettings(tx, country, settings, { by: 'Claude', replace: false, timezone })),
  );
}

/** Whether this runtime knows the IANA zone: a made-up one never reaches `regions`. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export type CountryRow = {
  code: string;
  name: string;
  rule: string;
  enabled: boolean;
  settings: unknown;
  createdAt: Date;
};

/** Every country's row, for the operator. On the operator's connection. */
export async function listCountrySettings(tx: Tx): Promise<CountryRow[]> {
  const rows = await regionRows(tx, KIND);
  return rows.map((row) => {
    let settings: unknown = null;
    try {
      settings = applyDocument(row.document, { country: row.region });
    } catch {
      // A broken document shows as null, for the operator to replace.
    }
    return {
      code: row.region!,
      name: countryName(row.region!),
      rule: row.name,
      enabled: row.enabled,
      settings,
      createdAt: row.created_at,
    };
  });
}

/**
 * Every place name a search term must not carry: the names and cities of every
 * country with a discovery.country row, in every spelling the row gives, not
 * only the job's own countries (a persona term naming Dubai is no use in SA).
 */
export async function placeWords(tenantId: string): Promise<string[]> {
  const all = await withTenant(tenantId, (tx) =>
    allValues<Partial<CountrySettings>>(tx, KIND, {}),
  );
  const words: string[] = [];
  for (const s of all) {
    if (Array.isArray(s.names)) words.push(...s.names);
    if (Array.isArray(s.cities)) words.push(...s.cities.flatMap((c) => Object.values(c)));
  }
  return [...new Set(words.filter((w) => typeof w === 'string').map(foldText).filter(Boolean))];
}

export function namesAPlace(term: string, places: string[]): boolean {
  const folded = ` ${foldText(term)} `;
  return places.some((place) => folded.includes(` ${place} `));
}

/** Whether a tenant's or the platform's discovery.blocked_hosts rows deny this host. */
export async function isBlockedHost(tenantId: string, country: string, host: string): Promise<boolean> {
  const { denied } = await withTenant(tenantId, (tx) =>
    evaluate(tx, { kind: 'discovery.blocked_hosts', tenantId, region: country, context: { host } }),
  );
  return denied;
}

export const isArabic = (text: string): boolean => /[؀-ۿ]/.test(text);
