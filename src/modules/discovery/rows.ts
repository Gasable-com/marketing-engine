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
  /** `header`: picked by column name. `guess`: picked by what the cells look like. */
  method: 'header' | 'guess';
};

const MAX_PRODUCT = 200;

/** Column names that hold the product's name, best first. Compared folded. */
const PRODUCT_HEADERS = [
  'product name',
  'product title',
  'product',
  'item name',
  'item',
  'name',
  'title',
  'product description',
  'item description',
  'description',
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
    'pending',
    'approved',
    'rejected',
    'under review',
    'archived',
    'hidden',
    'قيد المراجعة',
    'مقبول',
    'مرفوض',
    'معلق',
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
  // Keep trailing tabs: an empty last cell is still a cell. Drop the rule
  // line under a markdown table's header.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \r]+$/, ''))
    .filter((line) => line.trim() && !/^[\s|:=+-]+$/.test(line));
  if (lines.length === 0) return null;

  const first = splitCells(lines[0]!);
  const second = lines[1] !== undefined ? splitCells(lines[1]) : null;

  if (!isHeader(first, second)) return guess(first, null);
  // A header with no row under it says nothing about a product.
  if (!second) return null;

  const productIndex = columnOf(first, PRODUCT_HEADERS);
  const product = productIndex === null ? '' : clip(second[productIndex] ?? '');
  if (productIndex === null || !product || !isNameLike(product)) return guess(second, first);

  const categoryIndex = columnOf(first, CATEGORY_HEADERS);
  const category = categoryIndex === null ? '' : clip(second[categoryIndex] ?? '');
  return {
    product,
    category: category || null,
    cells: second,
    header: first,
    productIndex,
    categoryIndex: category ? categoryIndex : null,
    method: 'header',
  };
}

/**
 * Whether the first line names columns rather than holding a product: it has
 * a known column name, or it has no digits while the line under it does.
 */
function isHeader(first: string[], second: string[] | null): boolean {
  if (columnOf(first, PRODUCT_HEADERS) !== null || columnOf(first, CATEGORY_HEADERS) !== null) {
    return true;
  }
  const hasDigits = (cells: string[]) => cells.some((c) => /[\d٠-٩]/.test(c));
  return second !== null && !hasDigits(first) && hasDigits(second);
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
    method: 'guess',
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

/** Column names compared loosely: `Name (EN)` and `* Product name:` count. */
function columnOf(header: string[], names: string[]): number | null {
  const folded = header.map((cell) => foldText(cell.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')));
  for (const name of names) {
    const index = folded.indexOf(name);
    if (index >= 0) return index;
  }
  return null;
}

/** An amount with a currency on either side: `SAR 45`, `45.00 ر.س`, `$12`. */
const CURRENCY = String.raw`(?:sar|sr|aed|usd|egp|kwd|qar|bhd|omr|eur|riyals?|ريال سعودي|ريال|درهم|ر\.?\s?س\.?|د\.?\s?إ\.?|\$|€)`;
const PRICE = new RegExp(
  String.raw`^${CURRENCY}?\s*[\d٠-٩][\d٠-٩.,٫٬]*\s*${CURRENCY}?$`,
  'iu',
);

/** A quantity: a number and a unit, `12 kg`, `20 Liters`, `٥ لتر`. */
const QUANTITY =
  /^[\d٠-٩][\d٠-٩.,]*\s*(kg|kgs|g|gm|grams?|l|lt|ltr|liters?|litres?|ml|pcs?|pieces?|units?|ton|tons|كجم|كغ|كيلو|جم|جرام|لتر|مل|حبه|حبة|قطعه|قطعة|طن)\.?$/iu;

/** A code, not a name: no spaces, upper-case letters with digits, `DSL-20L`. */
const CODE = /^(?=.*\d)[A-Z0-9_./-]+$/;

/** A stock line with a count: `In stock (12)`, `متاح ١٢`. */
const STOCK = /^(in stock|out of stock|available|متاح|غير متاح)\s*[(:]?\s*[\d٠-٩]+\s*\)?$/iu;

function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

/**
 * Reads as a name: at least two letters, mostly letters, and not a URL, an
 * email address, a status, a price, a quantity or a code. Ids and dates fail
 * on letters.
 */
function isNameLike(cell: string): boolean {
  const text = cell.trim();
  if (!text) return false;
  if (/^(https?:\/\/|www\.)/i.test(text) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return false;
  if (STATUS_WORDS.has(foldText(text))) return false;
  if (PRICE.test(text) || QUANTITY.test(text) || CODE.test(text) || STOCK.test(text)) return false;

  const letters = letterCount(text);
  const visible = text.replace(/\s/g, '').length;
  return letters >= 2 && letters / visible >= 0.5;
}

function clip(text: string): string {
  return text.trim().slice(0, MAX_PRODUCT).trim();
}
