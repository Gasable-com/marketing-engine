import { withTenant } from '../../../db/client.js';
import { foldText } from '../../../spine/registry/index.js';
import { decide, evaluate } from '../../../spine/rules/index.js';

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

export async function countrySettings(tenantId: string, country: string): Promise<CountrySettings> {
  const { value } = await withTenant(tenantId, (tx) =>
    decide<Partial<CountrySettings>>(tx, {
      kind: 'discovery.country',
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

/** Every place name a search term must not carry, for these countries. */
export async function placeWords(tenantId: string, countries: string[]): Promise<string[]> {
  const words: string[] = [];
  for (const country of countries) {
    const s = await countrySettings(tenantId, country);
    words.push(...s.names, ...s.cities.flatMap((c) => Object.values(c)));
  }
  return [...new Set(words.map(foldText).filter(Boolean))];
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
