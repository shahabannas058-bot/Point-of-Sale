import { describe, expect, it } from 'vitest';
import { paisa } from '@pos/core';
import { ServiceError, type ModuleId } from '@pos/shared';
import {
  IMPORT_TEMPLATE_CSV,
  parseCsv,
  runStockImport,
  suggestSku,
  toImportRows,
  type ImportRow,
} from '../src/lib/stock-import';

const KIRYANA: readonly ModuleId[] = ['weight_units', 'batch_expiry'];
const MOBILE: readonly ModuleId[] = ['imei', 'warranty', 'repair'];
const HEADER = 'brand,name,sku,barcode,unit,cost,sale,qty,reorder';

const csv = (...lines: string[]): string => [HEADER, ...lines].join('\n');

describe('parseCsv', () => {
  it('splits plain rows and keeps file line numbers', () => {
    expect(parseCsv('a,b\n1,2\n3,4')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['1', '2'] },
      { line: 3, cells: ['3', '4'] },
    ]);
  });

  it('handles CRLF, a BOM and skips blank lines without losing line numbers', () => {
    expect(parseCsv('﻿a,b\r\n\r\n1,2\r\n')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 3, cells: ['1', '2'] },
    ]);
  });

  it('keeps commas, doubled quotes and newlines inside quoted cells', () => {
    expect(parseCsv('"Chini, white","12"" pack"\n"two\nlines",x')).toEqual([
      { line: 1, cells: ['Chini, white', '12" pack'] },
      { line: 2, cells: ['two\nlines', 'x'] },
    ]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('﻿\r\n\n')).toEqual([]);
  });
});

describe('suggestSku', () => {
  it('builds an upper-case slug from the name and avoids taken codes', () => {
    expect(suggestSku('Chini (sugar)', new Set())).toBe('CHINI-SUGAR');
    expect(suggestSku('Surf Excel 1kg', new Set(['SURF-EXCEL-1KG']))).toBe('SURF-EXCEL-1KG-2');
    expect(suggestSku('!!!', new Set())).toBe('ITEM');
  });
});

describe('toImportRows', () => {
  it('converts rupees to paisa and kg / litres to base units', () => {
    const { rows, problems } = toImportRows(
      csv(
        'Loose,Chini,CHINI,,kg,120,135.50,50.25,5',
        'Packed,Surf,SURF,8964000123456,pcs,285,310,24,6',
      ),
      { modules: KIRYANA },
    );
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        brand: 'Loose',
        name: 'Chini',
        sku: 'CHINI',
        barcode: null,
        unit: 'kg',
        costPrice: 12_000,
        salePrice: 13_550,
        openingQty: 50_250,
        reorderLevel: 5_000,
      },
      {
        line: 3,
        brand: 'Packed',
        name: 'Surf',
        sku: 'SURF',
        barcode: '8964000123456',
        unit: 'pcs',
        costPrice: 28_500,
        salePrice: 31_000,
        openingQty: 24,
        reorderLevel: 6,
      },
    ]);
  });

  it('accepts headers in any case and order and ignores extra columns', () => {
    const text = 'Qty,Extra,NAME,Sale,unit\n3,zzz,Lays,50,PCS';
    const { rows, problems } = toImportRows(text, { modules: KIRYANA });
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ name: 'Lays', salePrice: 5_000, openingQty: 3, unit: 'pcs' });
  });

  it('fills defaults: pcs, brand by unit, a generated sku, zero cost / reorder', () => {
    const { rows } = toImportRows(csv(',Chini,,,kg,,135,1,', ',Lays,,,,,50,,'), {
      modules: KIRYANA,
    });
    expect(rows[0]).toMatchObject({ brand: 'Loose', sku: 'CHINI', costPrice: 0, reorderLevel: 0 });
    expect(rows[1]).toMatchObject({
      brand: 'Packed',
      sku: 'LAYS',
      unit: 'pcs',
      openingQty: 0,
      reorderLevel: 0,
    });
  });

  it('generated skus never collide with typed ones', () => {
    const { rows } = toImportRows(csv(',Lays,,,,,50,1,', ',Lays,LAYS,,,,50,1,'), {
      modules: KIRYANA,
    });
    expect(rows.map((r) => r.sku)).toEqual(['LAYS-2', 'LAYS']);
  });

  it('reports a missing required column once and returns no rows', () => {
    const { rows, problems } = toImportRows('brand,sku\nx,y', { modules: KIRYANA });
    expect(rows).toEqual([]);
    expect(problems).toEqual([{ line: 1, field: 'name', code: 'missing_column' }]);
  });

  it('rejects bad rows one problem each and keeps the good ones', () => {
    const { rows, problems } = toImportRows(
      csv(
        ',,,,pcs,1,2,3,', // no name
        ',A,,,pcs,abc,2,3,', // bad cost
        ',B,,,pcs,1,-2,3,', // negative sale
        ',C,,,box,1,2,3,', // unknown unit
        ',D,,,pcs,1,2,1.5,', // fraction of a piece
        ',E,,,pcs,1,2,3,x', // bad reorder
        ',F,,,pcs,1,2,3,', // fine
      ),
      { modules: KIRYANA },
    );
    expect(rows.map((r) => r.name)).toEqual(['F']);
    expect(problems).toEqual([
      { line: 2, field: 'name', code: 'missing_name' },
      { line: 3, field: 'cost', code: 'bad_number' },
      { line: 4, field: 'sale', code: 'negative' },
      { line: 5, field: 'unit', code: 'bad_unit' },
      { line: 6, field: 'qty', code: 'bad_quantity' },
      { line: 7, field: 'reorder', code: 'bad_quantity' },
    ]);
  });

  it('rejects kg / L when the shop lacks the weight_units module', () => {
    const { rows, problems } = toImportRows(csv(',Chini,,,kg,1,2,3,', ',Oil,,,L,1,2,3,'), {
      modules: MOBILE,
    });
    expect(rows).toEqual([]);
    expect(problems.map((p) => p.code)).toEqual(['unit_module', 'unit_module']);
  });

  it('rejects duplicate sku and barcode inside the file (later row loses)', () => {
    const { rows, problems } = toImportRows(
      csv(',A,X1,111,pcs,1,2,3,', ',B,x1,222,pcs,1,2,3,', ',C,X3,111,pcs,1,2,3,'),
      { modules: KIRYANA },
    );
    expect(rows.map((r) => r.name)).toEqual(['A']);
    expect(problems).toEqual([
      { line: 3, field: 'sku', code: 'duplicate_sku' },
      { line: 4, field: 'barcode', code: 'duplicate_barcode' },
    ]);
  });

  it('rejects quantities above the service limit', () => {
    const { problems } = toImportRows(csv(',A,,,pcs,1,2,1000001,'), { modules: KIRYANA });
    expect(problems).toEqual([{ line: 2, field: 'qty', code: 'bad_quantity' }]);
  });

  it('the template parses cleanly for a kiryana shop', () => {
    const { rows, problems } = toImportRows(IMPORT_TEMPLATE_CSV, { modules: KIRYANA });
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(2);
  });
});

describe('runStockImport', () => {
  const row = (name: string, sku: string): ImportRow => ({
    line: 2,
    brand: 'Packed',
    name,
    sku,
    barcode: null,
    unit: 'pcs',
    costPrice: paisa(100),
    salePrice: paisa(200),
    openingQty: 1,
    reorderLevel: 0,
  });

  it('creates rows one after another and keeps going after a DUPLICATE', async () => {
    const calls: string[] = [];
    let inFlight = 0;
    const create = async (i: { sku: string }): Promise<void> => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      await Promise.resolve();
      inFlight -= 1;
      calls.push(i.sku);
      if (i.sku === 'DUP') throw new ServiceError('DUPLICATE', 'dup', { field: 'sku' });
    };
    const progress: number[] = [];
    const results = await runStockImport(
      create,
      [row('A', 'A1'), row('B', 'DUP'), row('C', 'C1')],
      (n) => progress.push(n),
    );
    expect(calls).toEqual(['A1', 'DUP', 'C1']);
    expect(progress).toEqual([1, 2, 3]);
    expect(results.map((r) => r.status)).toEqual(['created', 'failed', 'created']);
    const failed = results[1];
    expect(failed?.status === 'failed' && failed.error).toBeInstanceOf(ServiceError);
  });

  it('passes the row to the service in the shape createAccessory expects', async () => {
    const seen: unknown[] = [];
    await runStockImport(
      (i) => {
        seen.push(i);
        return Promise.resolve();
      },
      [{ ...row('Chini', 'CHINI'), unit: 'kg', openingQty: 1500, reorderLevel: 500 }],
      () => undefined,
    );
    expect(seen[0]).toEqual({
      product: { brand: 'Packed', name: 'Chini', category: 'Grocery' },
      sku: 'CHINI',
      barcode: null,
      unit: 'kg',
      costPrice: paisa(100),
      salePrice: paisa(200),
      reorderLevel: 500,
      openingQty: 1500,
    });
  });
});
