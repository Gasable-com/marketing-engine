import { foldText, normalizeName } from '../../../spine/registry/index.js';
import { MAX_QUOTE, MIN_QUOTE, type Extraction } from '../prompts.js';
import { PROFILE_ROLES, type ProfileRole } from '../roles.js';

/**
 * What survives of an extraction once every quote is checked against the
 * text it says it came from. Pure: no database, no network.
 *
 * A quote counts when the page its url names was actually read for this
 * candidate, it is between MIN_QUOTE and MAX_QUOTE characters once folded
 * (case, Arabic marks and letter forms, punctuation and spacing), and the
 * folded page contains it as whole words. Claude cannot cite a page nobody
 * read, a sentence that is not on it, a scrap of one, or the whole page.
 */

export type Source = { url: string; text: string };

export type Evidence = { signal: number | null; claim: string; quote: string; url: string };
export type Fact = { value: string; quote: string; url: string };

export type Checked =
  | { saved: false; reason: string; quotesChecked: number; quotesDropped: number }
  | {
      saved: true;
      name: Fact;
      nameAr: Fact | null;
      personaId: string;
      fit: 'strong' | 'weak';
      evidence: Evidence[];
      products: Fact[];
      roles: ProfileRole[];
      cities: Fact[];
      reason: string;
      quotesChecked: number;
      quotesDropped: number;
    };

const MAX_REASON = 120;

export function checkExtraction(
  answer: Extraction,
  input: {
    sources: Source[];
    personas: { id: string; signals: string[] }[];
    /** For a Maps-only company, the listing's own title and the url it is cited by. */
    listingTitle?: string | null;
    listingUrl?: string | null;
  },
): Checked {
  const pages = new Map(input.sources.map((s) => [s.url, ` ${foldText(s.text)} `]));
  let checked = 0;
  let dropped = 0;

  const holds = (quote: string, url: string): boolean => {
    const page = pages.get(url);
    const folded = foldText(quote);
    const ok =
      page !== undefined &&
      folded.length >= MIN_QUOTE &&
      quote.length <= MAX_QUOTE &&
      page.includes(` ${folded} `);
    ok ? (checked += 1) : (dropped += 1);
    return ok;
  };
  const keep = <T extends { quote: string; url: string }>(items: T[]) => items.filter((i) => holds(i.quote, i.url));
  const notSaved = (reason: string): Checked => ({
    saved: false,
    reason: reason.trim().slice(0, MAX_REASON) || 'not saved',
    quotesChecked: checked,
    quotesDropped: dropped,
  });

  const persona = answer.personaId ? input.personas.find((p) => p.id === answer.personaId) : undefined;
  if (answer.personaId && !persona) return notSaved('unknown persona');
  if (!answer.isCompany || answer.fit === 'none' || !persona) {
    return notSaved(answer.reason || (answer.isCompany ? 'fits no persona' : 'not a company'));
  }

  // The name decides identity, so it needs its own checked quote that
  // contains it, or, with no website read, to be the listing's own title:
  // then the listing title itself is what is saved and quoted.
  const given = answer.name;
  if (!given || normalizeName(given.value).length === 0) return notSaved('no checked name');
  let name: Fact;
  if (holds(given.quote, given.url) && ` ${foldText(given.quote)} `.includes(` ${foldText(given.value)} `)) {
    name = given;
  } else if (input.listingTitle && input.listingUrl && sameName(given.value, input.listingTitle)) {
    name = { value: input.listingTitle, quote: input.listingTitle, url: input.listingUrl };
  } else {
    return notSaved('no checked name');
  }

  const nameAr = answer.nameAr && holds(answer.nameAr.quote, answer.nameAr.url) ? answer.nameAr : null;
  const signals = persona.signals.length;
  const evidence = keep(answer.evidence)
    .map((e) => ({ ...e, signal: e.signal !== null && e.signal >= 0 && e.signal < signals ? e.signal : null }));

  return {
    saved: true,
    name,
    nameAr,
    personaId: persona.id,
    fit: answer.fit,
    evidence,
    products: keep(answer.products),
    roles: answer.roles.filter((r): r is ProfileRole => (PROFILE_ROLES as readonly string[]).includes(r)),
    cities: keep(answer.cities),
    reason: answer.reason.trim().slice(0, MAX_REASON),
    quotesChecked: checked,
    quotesDropped: dropped,
  };
}

/** The same name once legal forms, case and spelling are folded away. */
export function sameName(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return x.length > 0 && x === y;
}
