import { foldText, normalizeName } from '../../../spine/registry/index.js';
import { MIN_QUOTE, type Extraction } from '../prompts.js';
import { PROFILE_ROLES, type ProfileRole } from '../roles.js';

/**
 * What survives of an extraction once every quote is checked against the
 * text it says it came from. Pure: no database, no network.
 *
 * A quote counts when the page its url names was actually read for this
 * candidate, it is at least MIN_QUOTE characters, and the page contains it
 * once both are folded (case, Arabic marks and letter forms, punctuation and
 * spacing). Claude cannot cite a page nobody read, or a sentence that is not
 * on it.
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
    /** For a Maps-only company, the listing's own title. */
    listingTitle?: string | null;
  },
): Checked {
  const pages = new Map(input.sources.map((s) => [s.url, foldText(s.text)]));
  let checked = 0;
  let dropped = 0;

  const holds = (quote: string, url: string): boolean => {
    const page = pages.get(url);
    const folded = foldText(quote);
    const ok = page !== undefined && quote.trim().length >= MIN_QUOTE && folded.length > 0 && page.includes(folded);
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
  // contains it (or, with no website, to be the listing's own title).
  const name = answer.name;
  const nameHolds =
    name !== null &&
    holds(name.quote, name.url) &&
    (foldText(name.quote).includes(foldText(name.value)) ||
      (input.listingTitle ? sameName(name.value, input.listingTitle) : false));
  const nameIsListing = name !== null && input.listingTitle ? sameName(name.value, input.listingTitle) : false;
  if (!name || !(nameHolds || nameIsListing)) return notSaved('no checked name');

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

function sameName(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
}
