import { rupeesToPaisa } from '@pos/core';
import {
  hasModule,
  maxQuantity,
  parseQuantity,
  unitScaleFor,
  type ModuleId,
  type NewAccessoryInput,
  type Paisa,
  type UnitLabel,
} from '@pos/shared';

/**
 * Stock import from a CSV file (Excel users save as CSV). Pure: no React, no DOM, no service. The parser and the
 * validator are unit-tested; the runner takes the create function so it can be tested without a database.
 *
 * Columns (header row, case-insensitive, any order, extra columns ignored):
 *   brand, name, sku, barcode, unit (pcs | kg | L, default pcs), cost, sale (rupees, up to 2 decimals),
 *   qty (opening stock: pieces, or kg / litres with up to 3 decimals), reorder (same unit as qty).
 * Only name, sale and qty columns are required; the rest may be missing or empty.
 */

export const IMPORT_COLUMNS = [
  'brand',
  'name',
  'sku',
  'barcode',
  'unit',
  'cost',
  'sale',
  'qty',
  'reorder',
] as const;
export type ImportField = (typeof IMPORT_COLUMNS)[number];
const REQUIRED_COLUMNS: readonly ImportField[] = ['name', 'sale', 'qty'];

/** Rows beyond this are refused: a kiryana stock list is a few hundred lines, not a data warehouse. */
export const MAX_IMPORT_ROWS = 5000;
/** Rows shown in the preview table before importing. */
export const PREVIEW_ROWS = 50;

export const IMPORT_TEMPLATE_CSV = [
  IMPORT_COLUMNS.join(','),
  'Loose,Chini (sugar),,,kg,120,135.50,50,5',
  'Packed,Surf Excel 1kg,SURF-1KG,8964000123456,pcs,285,310,24,6',
  '',
].join('\r\n');

export interface CsvRow {
  /** 1-based line of the file where the row starts (what the shopkeeper sees in Excel). */
  line: number;
  cells: string[];
}

export interface ImportRow {
  line: number;
  brand: string;
  name: string;
  sku: string;
  barcode: string | null;
  unit: UnitLabel;
  costPrice: Paisa;
  salePrice: Paisa;
  /** Base units (pieces, or grams / millilitres). */
  openingQty: number;
  reorderLevel: number;
}

export type ImportProblemCode =
  | 'missing_column'
  | 'missing_name'
  | 'bad_number'
  | 'negative'
  | 'bad_unit'
  | 'unit_module'
  | 'bad_quantity'
  | 'duplicate_sku'
  | 'duplicate_barcode'
  | 'too_many_rows';

export interface ImportProblem {
  line: number;
  field: ImportField;
  /** Translated by the UI through `import.problem.<code>`. */
  code: ImportProblemCode;
}

export interface ImportParse {
  rows: ImportRow[];
  problems: ImportProblem[];
}

// ------------------------------------------------------------------ CSV

/** RFC 4180-ish: quoted cells may hold commas, newlines and doubled quotes. Blank lines are skipped. */
export function parseCsv(text: string): CsvRow[] {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let rowStarted = false;

  const endRow = (): void => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: rowLine, cells });
    cells = [];
    cell = '';
    rowStarted = false;
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] ?? '';
    if (!rowStarted) {
      rowStarted = true;
      rowLine = line;
    }
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\r') {
      /* CRLF: handled by the \n that follows */
    } else if (ch === '\n') {
      endRow();
      line += 1;
    } else cell += ch;
  }
  if (rowStarted) endRow();
  return rows;
}

// ------------------------------------------------------------------ values

const UNIT_WORDS: Readonly<Record<string, UnitLabel>> = {
  pcs: 'pcs',
  pc: 'pcs',
  piece: 'pcs',
  pieces: 'pcs',
  kg: 'kg',
  kilo: 'kg',
  l: 'L',
  ltr: 'L',
  litre: 'L',
  liter: 'L',
};

const parseUnit = (text: string): UnitLabel | null =>
  text === '' ? 'pcs' : (UNIT_WORDS[text.toLowerCase()] ?? null);

type Parsed<T> = { ok: true; value: T } | { ok: false; code: ImportProblemCode };

/** Rupees -> paisa; an empty cell is zero when `optional`. */
function parseMoney(text: string, optional: boolean): Parsed<Paisa> {
  if (text === '' && optional) return { ok: true, value: 0 as Paisa };
  try {
    const value = rupeesToPaisa(text);
    return value < 0 ? { ok: false, code: 'negative' } : { ok: true, value };
  } catch {
    return { ok: false, code: 'bad_number' };
  }
}

/** Pieces, or kg / litres with up to 3 decimals, -> base units; an empty cell is zero. */
function parseAmount(text: string, unit: UnitLabel): Parsed<number> {
  if (text === '') return { ok: true, value: 0 };
  if (text.startsWith('-')) return { ok: false, code: 'negative' };
  const scale = unitScaleFor(unit);
  const value = parseQuantity(text.replace(/,/g, ''), scale);
  if (value === null || value > maxQuantity(scale)) return { ok: false, code: 'bad_quantity' };
  return { ok: true, value };
}

/** "Chini (sugar)" -> "CHINI-SUGAR"; "-2", "-3" ... while the code is taken. Never empty. */
export function suggestSku(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24)
      .replace(/-$/, '') || 'ITEM';
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n += 1) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ------------------------------------------------------------------ rows

type Columns = Partial<Record<ImportField, number>>;

function readHeader(cells: readonly string[]): Columns {
  const known = new Set<string>(IMPORT_COLUMNS);
  const columns: Columns = {};
  cells.forEach((cell, i) => {
    const key = cell.trim().toLowerCase();
    if (known.has(key) && columns[key as ImportField] === undefined)
      columns[key as ImportField] = i;
  });
  return columns;
}

/** One data row -> an ImportRow (sku may still be empty), or its first problem. */
function readRow(
  row: CsvRow,
  columns: Columns,
  modules: readonly ModuleId[],
): { ok: true; value: ImportRow } | { ok: false; problem: ImportProblem } {
  const cell = (f: ImportField): string => {
    const i = columns[f];
    return i === undefined ? '' : (row.cells[i] ?? '').trim();
  };
  const fail = (field: ImportField, code: ImportProblemCode) => ({
    ok: false as const,
    problem: { line: row.line, field, code },
  });

  const name = cell('name');
  if (name === '') return fail('name', 'missing_name');
  const unit = parseUnit(cell('unit'));
  if (unit === null) return fail('unit', 'bad_unit');
  if (unit !== 'pcs' && !hasModule(modules, 'weight_units')) return fail('unit', 'unit_module');
  const cost = parseMoney(cell('cost'), true);
  if (!cost.ok) return fail('cost', cost.code);
  const sale = parseMoney(cell('sale'), false);
  if (!sale.ok) return fail('sale', sale.code);
  const qty = parseAmount(cell('qty'), unit);
  if (!qty.ok) return fail('qty', qty.code);
  const reorder = parseAmount(cell('reorder'), unit);
  if (!reorder.ok) return fail('reorder', reorder.code);

  const brand = cell('brand') || (unit === 'pcs' ? 'Packed' : 'Loose');
  return {
    ok: true,
    value: {
      line: row.line,
      brand,
      name,
      sku: cell('sku'),
      barcode: cell('barcode') || null,
      unit,
      costPrice: cost.value,
      salePrice: sale.value,
      openingQty: qty.value,
      reorderLevel: reorder.value,
    },
  };
}

/** Drops rows whose typed sku / barcode repeats an earlier row, then fills the missing skus without collisions. */
function assignSkus(rows: readonly ImportRow[], problems: ImportProblem[]): ImportRow[] {
  const skus = new Set<string>();
  const barcodes = new Set<string>();
  const kept: ImportRow[] = [];
  for (const row of rows) {
    const sku = row.sku.toUpperCase();
    if (sku !== '' && skus.has(sku)) {
      problems.push({ line: row.line, field: 'sku', code: 'duplicate_sku' });
      continue;
    }
    if (row.barcode !== null && barcodes.has(row.barcode)) {
      problems.push({ line: row.line, field: 'barcode', code: 'duplicate_barcode' });
      continue;
    }
    if (sku !== '') skus.add(sku);
    if (row.barcode !== null) barcodes.add(row.barcode);
    kept.push(row);
  }
  return kept.map((row) => {
    if (row.sku !== '') return row;
    const sku = suggestSku(row.name, skus);
    skus.add(sku);
    return { ...row, sku };
  });
}

/**
 * CSV text -> validated rows plus one problem per rejected row. Rows with a problem are left out of `rows`;
 * problems are sorted by line. A missing required column yields a single problem on line 1 and no rows.
 */
export function toImportRows(text: string, opts: { modules: readonly ModuleId[] }): ImportParse {
  const [header, ...data] = parseCsv(text);
  if (header === undefined) return { rows: [], problems: [] };
  const columns = readHeader(header.cells);
  const missing = REQUIRED_COLUMNS.find((f) => columns[f] === undefined);
  if (missing !== undefined)
    return { rows: [], problems: [{ line: header.line, field: missing, code: 'missing_column' }] };
  if (data.length > MAX_IMPORT_ROWS)
    return { rows: [], problems: [{ line: header.line, field: 'name', code: 'too_many_rows' }] };

  const problems: ImportProblem[] = [];
  const parsed: ImportRow[] = [];
  for (const row of data) {
    const result = readRow(row, columns, opts.modules);
    if (result.ok) parsed.push(result.value);
    else problems.push(result.problem);
  }
  const rows = assignSkus(parsed, problems);
  problems.sort((a, b) => a.line - b.line);
  return { rows, problems };
}

// ------------------------------------------------------------------ import run

export type ImportResult =
  { row: ImportRow; status: 'created' } | { row: ImportRow; status: 'failed'; error: unknown };

/** The service call for one row: `service.catalog.createAccessory`. */
export type CreateItem = (input: NewAccessoryInput) => Promise<unknown>;

export const toAccessoryInput = (row: ImportRow): NewAccessoryInput => ({
  product: { brand: row.brand, name: row.name, category: 'Grocery' },
  sku: row.sku,
  barcode: row.barcode,
  unit: row.unit,
  costPrice: row.costPrice,
  salePrice: row.salePrice,
  reorderLevel: row.reorderLevel,
  openingQty: row.openingQty,
});

/**
 * Creates the rows one after another (the service holds a write lock, so parallel calls would only queue) and
 * never stops on a failed row: a DUPLICATE sku is reported for that row while the rest go in. `onProgress`
 * receives the number of rows finished so far.
 */
export async function runStockImport(
  create: CreateItem,
  rows: readonly ImportRow[],
  onProgress: (done: number) => void,
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  for (const row of rows) {
    try {
      await create(toAccessoryInput(row));
      results.push({ row, status: 'created' });
    } catch (error) {
      results.push({ row, status: 'failed', error });
    }
    onProgress(results.length);
  }
  return results;
}
