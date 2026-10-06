import { foldText } from '../../spine/registry/index.js';

/**
 * Read a product out of a row pasted from a table: what an operator copies
 * from the portal's product list to start a search. Pure, no database.
 *
 * A row copied from a web table arrives tab-separated; one typed or copied
 * from elsewhere may use pipes or commas. When the header line is pasted
 * above the row, the columns are picked by name. Without one it is a guess:
 * the longest cell that reads as a name is the product, and the next one the
 * category. The operator sees the guess and corrects it before searching.
 */

export type RowReading = {
  product: string;
  category: string | null;
  /** The row's cells, trimmed, in order. */
  cells: string[];
  /** The header's cells when one was pasted above the row. */
  header: string[] | null;
  productIndex: number;
  categoryIndex: number | null;
};

const MAX_PRODUCT = 200;

/** Column names that hold the product's name, best first. Compared folded. */
const PRODUCT_HEADERS = [
  'product name',
  'product',
  'item name',
  'item',
  'name',
  'title',
  'اسم المنتج',
  'المنتج',
  'منتج',
  'اسم الصنف',
  'الصنف',
  'الاسم',
  'اسم',
].map(foldText);

const CATEGORY_HEADERS = [
  'category name',
  'category',
  'sub category',
  'subcategory',
  'type',
  'الفئه',
  'فئه',
  'التصنيف',
  'تصنيف',
  'القسم',
  'النوع',
].map(foldText);

/** Cells that describe a row's state, not a product. Compared folded. */
const STATUS_WORDS = new Set(
  [
    'active',
    'inactive',
    'enabled',
    'disabled',
    'published',
    'unpublished',
    'draft',
    'yes',
    'no',
    'true',
    'false',
    'available',
    'unavailable',
    'in stock',
    'out of stock',
    'نشط',
    'غير نشط',
    'مفعل',
    'غير مفعل',
    'متاح',
    'غير متاح',
    'نعم',
    'لا',
  ].map(foldText),
);

export function readRow(text: string): RowReading | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim());
  if (lines.length === 0) return null;

  const first = splitCells(lines[0]!);
  const second = lines[1] !== undefined ? splitCells(lines[1]) : null;
  const headerHit = second ? columnOf(first, PRODUCT_HEADERS) : null;

  // A first line naming a product column, above a row of the same width, is
  // the header; anything else means the first line is the row itself.
  if (!second || headerHit === null || second.length !== first.length) return guess(first, null);

  const product = clip(second[headerHit] ?? '');
  if (!product || !isNameLike(product)) return guess(second, first);

  const categoryIndex = columnOf(first, CATEGORY_HEADERS);
  const category = categoryIndex === null ? '' : clip(second[categoryIndex] ?? '');
  return {
    product,
    category: category || null,
    cells: second,
    header: first,
    productIndex: headerHit,
    categoryIndex: category ? categoryIndex : null,
  };
}

/** No usable header: the longest name-like cell, then the next one. */
function guess(cells: string[], header: string[] | null): RowReading | null {
  const names = cells
    .map((cell, index) => ({ cell, index, letters: letterCount(cell) }))
    .filter((c) => isNameLike(c.cell));
  if (names.length === 0) return null;

  const best = names.reduce((a, b) => (b.letters > a.letters ? b : a));
  const others = names.filter((c) => c.index !== best.index);
  const category = others.find((c) => c.index > best.index) ?? others[0] ?? null;

  return {
    product: clip(best.cell),
    category: category ? clip(category.cell) : null,
    cells,
    header,
    productIndex: best.index,
    categoryIndex: category ? category.index : null,
  };
}

function splitCells(line: string): string[] {
  let cells: string[];
  if (line.includes('\t')) cells = line.split('\t');
  else if (line.includes('|')) cells = line.split('|');
  else if (line.split(',').length >= 3) cells = line.split(',');
  else cells = [line];

  // A pipe table starts and ends with a pipe; those edges are not cells.
  cells = cells.map((c) => c.trim());
  if (cells.length > 1 && cells[0] === '' && line.trim().startsWith('|')) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1] === '' && line.trim().endsWith('|')) cells.pop();
  return cells;
}

function columnOf(header: string[], names: string[]): number | null {
  const folded = header.map(foldText);
  for (const name of names) {
    const index = folded.indexOf(name);
    if (index >= 0) return index;
  }
  return null;
}

/** An amount with a currency on either side: `SAR 45`, `45.00 ر.س`, `$12`. */
const CURRENCY = String.raw`(?:sar|aed|usd|egp|kwd|qar|bhd|omr|eur|ريال|درهم|ر\.?\s?س|د\.?\s?إ|\$|€)`;
const PRICE = new RegExp(
  String.raw`^${CURRENCY}?\s*[\d٠-٩][\d٠-٩.,٫٬]*\s*${CURRENCY}?$`,
  'iu',
);

function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

/**
 * Reads as a name: at least two letters, mostly letters, and not a URL, an
 * email address or a status. Ids, prices, dates and quantities fail on letters.
 */
function isNameLike(cell: string): boolean {
  const text = cell.trim();
  if (!text) return false;
  if (/^(https?:\/\/|www\.)/i.test(text) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return false;
  if (STATUS_WORDS.has(foldText(text))) return false;
  if (PRICE.test(text)) return false;

  const letters = letterCount(text);
  const visible = text.replace(/\s/g, '').length;
  return letters >= 2 && letters / visible >= 0.5;
}

function clip(text: string): string {
  return text.trim().slice(0, MAX_PRODUCT).trim();
}
