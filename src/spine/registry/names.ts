/**
 * Fold a company name down to what is worth matching on. The stored `name` is
 * always the contributor's; this is only ever compared, never shown.
 *
 * Arabic needs the same treatment as English: the same company is written
 * شركة الفلاح للتجارة on one list and الفلاح للتجاره on another, and the
 * difference is entirely orthographic.
 */

/** Tashkeel (harakat) and tatweel: decoration, never meaning. */
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** Legal-form and generic-trade words, in both languages. */
const NOISE_WORDS = new Set([
  // Arabic
  'شركة',
  'شركه',
  'مؤسسة',
  'مؤسسه',
  'موسسة',
  'موسسه',
  'ش.م.م',
  'ذ.م.م',
  'المحدودة',
  'المحدوده',
  'محدودة',
  'محدوده',
  'للتجارة',
  'للتجاره',
  'التجارية',
  'التجاريه',
  // English
  'co',
  'company',
  'ltd',
  'limited',
  'llc',
  'inc',
  'est',
  'establishment',
  'trading',
  'for',
  'and',
]);

/**
 * The letter folding on its own: lower case, Arabic marks gone, the letters
 * people write interchangeably made one, and anything that is not a letter or
 * digit a single space. Unlike normalizeName it keeps every word, so in
 * product text a word like شركة still counts.
 *
 * `fold_text()` in migration 0016 is the same folding in SQL, and what the
 * products finder compares with, on both sides. Keep the two in step; for
 * scripts with combining marks beyond Arabic the database's locale decides
 * what counts as a letter, so they can differ there.
 */
export function foldText(text: string): string {
  let folded = text.toLowerCase();

  folded = folded.replace(ARABIC_MARKS, '');
  folded = folded
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىئ]/g, 'ي')
    .replace(/ؤ/g, 'و');

  // Punctuation goes, so "Co." and "co" and "& Co" fold together. Keep letters
  // and digits of any script.
  folded = folded.replace(/[^\p{L}\p{N}]+/gu, ' ');

  return folded.trim();
}

export function normalizeName(name: string): string {
  return foldText(name)
    .split(' ')
    .filter((w) => w && !NOISE_WORDS.has(w))
    .join(' ');
}
