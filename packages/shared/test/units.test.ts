import { describe, expect, it } from 'vitest';
import {
  AccessoryVariantSchema,
  InvoiceSchema,
  MODULE_IDS,
  MODULE_PRESETS,
  SaleLineSchema,
  formatModuleList,
  formatQuantity,
  hasModule,
  lineGross,
  parseModuleList,
  parseQuantity,
  unitScaleFor,
  type ModuleId,
} from '../src';

const id = (n: number): string => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const HASH = 'a'.repeat(64);

describe('lineGross: quantity * unitPrice / unitScale, rounded half away from zero', () => {
  it.each([
    // [quantity, unitPrice, scale, expected]
    [1250, 28_550, 1000, 35_688], // 35,687.5 -> up
    [-1250, 28_550, 1000, -35_688], // -35,687.5 -> away from zero
    [333, 12_000, 1000, 3_996], // exact
    [500, 1, 1000, 1], // 0.5 -> 1
    [-500, 1, 1000, -1],
    [499, 1, 1000, 0], // 0.499 -> 0
    [-499, 1, 1000, 0],
    [1, 1, 1000, 0],
    [0, 5, 1000, 0],
    [3, 2_500, 1, 7_500], // pieces: plain product
    [-3, 2_500, 1, -7_500],
  ] as const)('%d x %d / %d = %d', (quantity, unitPrice, scale, expected) => {
    expect(lineGross(quantity, unitPrice, scale)).toBe(expected);
  });

  it('never returns -0', () => {
    expect(Object.is(lineGross(-1, 1, 1000), 0)).toBe(true);
  });

  it('is exact where a float multiply would not be', () => {
    const quantity = 99_999_999;
    const unitPrice = 9_007_199;
    const exact = (BigInt(quantity) * BigInt(unitPrice) + 500n) / 1000n;
    expect(lineGross(quantity, unitPrice, 1000)).toBe(Number(exact));
  });

  it('defaults to pieces', () => {
    expect(lineGross(4, 250)).toBe(1000);
  });
});

describe('formatQuantity / parseQuantity', () => {
  it.each([
    [1500, 1000, '1.5'],
    [1000, 1000, '1'],
    [250, 1000, '0.25'],
    [5, 1000, '0.005'],
    [0, 1000, '0'],
    [-1250, 1000, '-1.25'],
    [3, 1, '3'],
  ] as const)('format %d (scale %d) -> %s', (q, scale, text) => {
    expect(formatQuantity(q, scale)).toBe(text);
  });

  it.each([
    ['1.5', 1000, 1500],
    ['0.25', 1000, 250],
    ['2', 1000, 2000],
    ['0.005', 1000, 5],
    [' 1.5 ', 1000, 1500],
    ['3', 1, 3],
  ] as const)('parse "%s" (scale %d) -> %d', (text, scale, q) => {
    expect(parseQuantity(text, scale)).toBe(q);
  });

  it.each([
    ['1.2345', 1000], // more than 3 decimals
    ['abc', 1000],
    ['', 1000],
    ['-1', 1000],
    ['1,5', 1000],
    ['1.5', 1], // pieces are whole numbers
    ['.5', 1000],
  ] as const)('parse "%s" (scale %d) -> null', (text, scale) => {
    expect(parseQuantity(text, scale)).toBeNull();
  });

  it('round-trips', () => {
    for (const q of [1, 7, 250, 999, 1000, 1234, 100_000_000])
      expect(parseQuantity(formatQuantity(q, 1000), 1000)).toBe(q);
  });
});

describe('modules', () => {
  it('presets only name known modules, and custom owns all of them', () => {
    for (const list of Object.values(MODULE_PRESETS))
      for (const m of list) expect(MODULE_IDS).toContain(m);
    expect([...MODULE_PRESETS.custom].sort()).toEqual([...MODULE_IDS].sort());
  });

  it('a kiryana shop has no phone modules, a mobile shop has no weight units', () => {
    expect(hasModule(MODULE_PRESETS.kiryana, 'weight_units')).toBe(true);
    for (const m of ['imei', 'repair', 'warranty'] as const)
      expect(hasModule(MODULE_PRESETS.kiryana, m)).toBe(false);
    expect(hasModule(MODULE_PRESETS.mobile, 'weight_units')).toBe(false);
    expect(hasModule(MODULE_PRESETS.mobile, 'imei')).toBe(true);
  });

  it('parseModuleList drops unknown ids so an older app survives a newer licence', () => {
    expect(parseModuleList('imei, bogus ,repair,,')).toEqual(['imei', 'repair']);
    expect(parseModuleList('')).toEqual([]);
  });

  it('format and parse round-trip', () => {
    const list: ModuleId[] = ['weight_units', 'batch_expiry'];
    expect(parseModuleList(formatModuleList(list))).toEqual(list);
  });
});

describe('schemas carry the unit', () => {
  const variantLine = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: id(1),
    saleId: id(2),
    lineNo: 1,
    productId: id(3),
    phoneUnitId: null,
    variantId: id(4),
    description: 'Chini (sugar) loose',
    quantity: 1250,
    unitScale: 1000,
    unitPrice: 28_550,
    costPrice: 25_000,
    discountAmount: 0,
    lineTotal: 35_688,
    createdAt: 1_760_000_000_000,
    ...over,
  });

  it('accepts a weighted line whose total uses the rounded rule', () => {
    expect(SaleLineSchema.safeParse(variantLine()).success).toBe(true);
  });

  it('rejects a weighted line priced with the piece formula or rounded the wrong way', () => {
    expect(SaleLineSchema.safeParse(variantLine({ lineTotal: 35_687 })).success).toBe(false);
    expect(SaleLineSchema.safeParse(variantLine({ lineTotal: 35_687_500 })).success).toBe(false);
  });

  it('defaults a missing unitScale to 1 (older payloads)', () => {
    const { unitScale: _omit, ...rest } = variantLine({
      quantity: 2,
      unitPrice: 500,
      lineTotal: 1000,
    });
    const parsed = SaleLineSchema.parse(rest);
    expect(parsed.unitScale).toBe(1);
  });

  it('rejects a phone unit sold by weight', () => {
    const r = SaleLineSchema.safeParse(
      variantLine({ phoneUnitId: id(5), variantId: null, quantity: 1, lineTotal: 28 }),
    );
    expect(r.success).toBe(false);
  });

  const invoice = (hashVersion: 1 | 2): Record<string, unknown> => ({
    id: id(2),
    deviceId: id(10),
    seq: 1,
    invoiceNo: 'K-000001',
    kind: 'sale',
    originalSaleId: null,
    branchId: id(11),
    customerId: null,
    cashierId: id(12),
    subtotal: 35_688,
    discountTotal: 0,
    total: 35_688,
    note: null,
    createdAt: 1_760_000_000_000,
    hashVersion,
    prevHash: '0'.repeat(64),
    hash: HASH,
    lines: [variantLine()],
    payments: [
      {
        id: id(6),
        saleId: id(2),
        method: 'cash',
        amount: 35_688,
        reference: null,
        createdAt: 1_760_000_000_000,
      },
    ],
  });

  it('hashVersion 2 may carry weighted lines, hashVersion 1 may not', () => {
    expect(InvoiceSchema.safeParse(invoice(2)).success).toBe(true);
    const v1 = InvoiceSchema.safeParse(invoice(1));
    expect(v1.success).toBe(false);
    expect(JSON.stringify(v1.error?.issues)).toContain('hashVersion 1');
  });

  const variant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: id(4),
    productId: id(3),
    sku: 'CHINI-LOOSE',
    barcode: null,
    model: null,
    colour: null,
    costPrice: 25_000,
    salePrice: 28_550,
    reorderLevel: 5_000,
    unitScale: 1000,
    unitLabel: 'kg',
    isActive: true,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    ...over,
  });

  it('a variant label and scale must agree', () => {
    expect(AccessoryVariantSchema.safeParse(variant()).success).toBe(true);
    expect(AccessoryVariantSchema.safeParse(variant({ unitLabel: 'L' })).success).toBe(true);
    expect(AccessoryVariantSchema.safeParse(variant({ unitScale: 1 })).success).toBe(false);
    expect(
      AccessoryVariantSchema.safeParse(variant({ unitLabel: 'pcs', unitScale: 1000 })).success,
    ).toBe(false);
  });

  it('a variant without unit fields is a piece item', () => {
    const { unitScale: _s, unitLabel: _l, ...old } = variant();
    const parsed = AccessoryVariantSchema.parse(old);
    expect(parsed).toMatchObject({ unitScale: 1, unitLabel: 'pcs' });
    expect(unitScaleFor('pcs')).toBe(1);
    expect(unitScaleFor('kg')).toBe(1000);
  });
});
