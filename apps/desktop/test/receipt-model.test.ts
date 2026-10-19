import { describe, expect, it } from 'vitest';
import type { InvoiceView, ShopSettings } from '@pos/shared';
import { buildReceiptModel } from '../src/lib/receipt-model';

const settings: ShopSettings = {
  shopName: 'Test Kiryana',
  address: null,
  phone: null,
  receiptFooter: null,
  receiptFooterUr: null,
  cashierMaxDiscountBps: 500,
  allowNegativeStock: false,
};
const shop = { branchName: 'Main' };

interface LineIn {
  variantId?: string | null;
  phoneUnitId?: string | null;
  description: string;
  quantity: number;
  unitScale: 1 | 1000;
  unitPrice: number;
  discountAmount?: number;
  lineTotal: number;
}

const view = (kind: 'sale' | 'return', lines: LineIn[]): InvoiceView => {
  const total = lines.reduce((a, l) => a + l.lineTotal, 0);
  return {
    invoice: {
      id: 's1',
      kind,
      invoiceNo: 'K-000001',
      createdAt: 1,
      subtotal: total,
      discountTotal: 0,
      total,
      lines: lines.map((l, i) => ({
        id: `l${i}`,
        variantId: null,
        phoneUnitId: null,
        discountAmount: 0,
        ...l,
      })),
      payments: [{ method: 'cash', amount: total }],
    },
    customerName: null,
    cashierName: 'Ali',
    originalInvoiceNo: null,
  } as unknown as InvoiceView;
};

describe('buildReceiptModel with units', () => {
  it('a piece line keeps its quantity and is labelled pcs', () => {
    const m = buildReceiptModel(
      view('sale', [
        {
          variantId: 'pens',
          description: 'Pen',
          quantity: 3,
          unitScale: 1,
          unitPrice: 2_500,
          lineTotal: 7_500,
        },
      ]),
      shop,
      settings,
    );
    expect(m.items[0]).toMatchObject({
      name: 'Pen',
      qty: 3,
      unitScale: 1,
      unitLabel: 'pcs',
      unitPrice: 2_500,
      total: 7_500,
    });
  });

  it('a weighed line keeps its grams and scale, and defaults to kg', () => {
    const m = buildReceiptModel(
      view('sale', [
        {
          variantId: 'chini',
          description: 'Chini loose',
          quantity: 1250,
          unitScale: 1000,
          unitPrice: 28_550,
          lineTotal: 35_688,
        },
      ]),
      shop,
      settings,
    );
    expect(m.items[0]).toMatchObject({
      qty: 1250,
      unitScale: 1000,
      unitLabel: 'kg',
      unitPrice: 28_550,
      total: 35_688,
    });
  });

  it('uses the unit label of the variant when it is known (litres)', () => {
    const m = buildReceiptModel(
      view('sale', [
        {
          variantId: 'oil',
          description: 'Cooking oil loose',
          quantity: 500,
          unitScale: 1000,
          unitPrice: 60_000,
          lineTotal: 30_000,
        },
      ]),
      shop,
      settings,
      {},
      { oil: 'L' },
    );
    expect(m.items[0]?.unitLabel).toBe('L');
  });

  it('a return shows positive quantities and totals', () => {
    const m = buildReceiptModel(
      view('return', [
        {
          variantId: 'chini',
          description: 'Chini loose',
          quantity: -500,
          unitScale: 1000,
          unitPrice: 28_550,
          lineTotal: -14_275,
        },
      ]),
      shop,
      settings,
    );
    expect(m.items[0]).toMatchObject({ qty: 500, total: 14_275, unitScale: 1000 });
    expect(m.total).toBe(14_275);
  });

  it('a phone line is always pieces, whatever the label map says', () => {
    const m = buildReceiptModel(
      view('sale', [
        {
          phoneUnitId: 'u1',
          description: 'Galaxy A55',
          quantity: 1,
          unitScale: 1,
          unitPrice: 8_500_000,
          lineTotal: 8_500_000,
        },
      ]),
      shop,
      settings,
      { u1: '356938035643809' },
      { u1: 'kg' },
    );
    expect(m.items[0]).toMatchObject({ unitLabel: 'pcs', sub: '356938035643809' });
  });
});

describe('buildReceiptModel: a weight round-off is not printed as a discount', () => {
  it('"Rs 250 ke chawal" prints 1.316 kg x 190/kg = 250.00 with no discount anywhere', () => {
    // 1316 g at Rs 190/kg is Rs 250.04; the 4 paisa came off so the line is exactly Rs 250
    const m = buildReceiptModel(
      view('sale', [
        {
          variantId: 'chawal',
          description: 'Chawal Basmati',
          quantity: 1316,
          unitScale: 1000,
          unitPrice: 19_000,
          discountAmount: 4,
          lineTotal: 25_000,
        },
      ]),
      shop,
      settings,
    );
    expect(m.items[0]).toMatchObject({ qty: 1316, unitPrice: 19_000, discount: 0, total: 25_000 });
    expect(m.discountTotal).toBe(0);
    expect(m.total).toBe(25_000);
  });

  it('a real discount on a weighed line is still printed', () => {
    const m = buildReceiptModel(
      view('sale', [
        {
          variantId: 'chawal',
          description: 'Chawal Basmati',
          quantity: 2000,
          unitScale: 1000,
          unitPrice: 19_000,
          discountAmount: 1_000,
          lineTotal: 37_000,
        },
      ]),
      shop,
      settings,
    );
    expect(m.items[0]).toMatchObject({ discount: 1_000, total: 37_000 });
    expect(m.discountTotal).toBe(1_000);
  });
});
