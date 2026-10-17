import {
  GENESIS_HASH,
  HASH_VERSION,
  assertPaymentsMatchTotal,
  computeInvoiceHash,
  createUuidV7Generator,
  formatInvoiceNo,
  invoiceHashPayload,
  paisa,
  saleTotals,
  type UnsealedInvoice,
} from '@pos/core';
import type { PaymentMethod, SaleKind, SaleLine, SalePayment } from '@pos/shared';
import { seededBytes } from './rng';

/** Shape read by InvoiceVectorTests (GoldenVectorTests.cs). */
export interface InvoiceVector {
  name: string;
  description: string;
  previous_hash: string;
  unsealed_data: UnsealedInvoice;
  canonical: string;
  expected_hash: string;
}

interface LineSpec {
  product: string;
  phoneUnit?: string;
  variant?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  discount?: number;
}

interface PaymentSpec {
  method: PaymentMethod;
  /** Omitted = whatever is left of the total after the explicit amounts. */
  amount?: number;
  reference?: string | null;
}

interface InvoiceSpec {
  name: string;
  description: string;
  kind?: SaleKind;
  /** Name of an earlier vector this return / void refers to. */
  original?: string;
  customer?: string;
  note?: string | null;
  invoiceDiscount?: number;
  lines: LineSpec[];
  payments: PaymentSpec[];
  /** Store lines/payments in reverse order so the canonical sort is exercised. */
  reverseArrays?: boolean;
}

const BASE_TIME_MS = 1_760_000_000_000; // 2025-10-09T08:53:20Z
const STEP_MS = 60_000;
const INVOICE_PREFIX = 'A';

const SPECIAL_TEXT =
  'Quote " backslash \\ slash / newline\n tab\t cr\r nul\u0000 ctl\u0001\u001f del\u007f ' +
  "html </script> <b> & 'apos' nbsp  ls  ps  bom﻿ é 😀 👨‍👩‍👧 🇵🇰";

const SPECS: readonly InvoiceSpec[] = [
  {
    name: 'cash-sale-simple',
    description: 'Two chargers, paid in cash',
    lines: [
      {
        product: 'charger',
        description: 'Fast charger 25W',
        quantity: 2,
        unitPrice: 50_000,
        costPrice: 32_000,
      },
    ],
    payments: [{ method: 'cash' }],
  },
  {
    name: 'split-payment',
    description: 'Phone paid with cash + JazzCash + card; payments stored out of id order',
    lines: [
      {
        product: 'phone-a15',
        phoneUnit: 'unit-a15-1',
        variant: 'a15-128',
        description: 'Samsung Galaxy A15 128GB Black',
        quantity: 1,
        unitPrice: 5_499_900,
        costPrice: 4_950_000,
      },
    ],
    payments: [
      { method: 'cash', amount: 2_000_000 },
      { method: 'jazzcash', amount: 3_000_000, reference: 'JC-0034-778812' },
      { method: 'card', reference: 'VISA ****4242' },
    ],
    reverseArrays: true,
  },
  {
    name: 'khata-full',
    description: 'Whole invoice on the customer khata (credit)',
    customer: 'customer-ali',
    note: 'Udhaar - pays on Friday',
    lines: [
      {
        product: 'cover',
        description: 'Silicone back cover',
        quantity: 3,
        unitPrice: 45_000,
        costPrice: 15_000,
      },
    ],
    payments: [{ method: 'khata' }],
  },
  {
    name: 'khata-partial-cash',
    description: 'Part cash, rest on khata',
    customer: 'customer-ali',
    lines: [
      {
        product: 'earbuds',
        description: 'Wireless earbuds',
        quantity: 1,
        unitPrice: 349_900,
        costPrice: 250_000,
      },
    ],
    payments: [{ method: 'cash', amount: 100_000 }, { method: 'khata' }],
  },
  {
    name: 'line-and-invoice-discount',
    description: 'Line discounts plus an invoice discount; lines stored out of lineNo order',
    lines: [
      {
        product: 'phone-a05',
        phoneUnit: 'unit-a05-1',
        variant: 'a05-64',
        description: 'Samsung Galaxy A05 64GB',
        quantity: 1,
        unitPrice: 199_950,
        costPrice: 170_000,
        discount: 19_995,
      },
      {
        product: 'charger',
        description: 'Fast charger 25W',
        quantity: 2,
        unitPrice: 50_000,
        costPrice: 32_000,
        discount: 5_000,
      },
    ],
    invoiceDiscount: 4_955,
    payments: [{ method: 'cash' }],
    reverseArrays: true,
  },
  {
    name: 'return-negative-quantities',
    description: 'Return of the discounted phone: negative quantity, discount and payment',
    kind: 'return',
    original: 'line-and-invoice-discount',
    note: 'Screen flicker, returned within 7 days',
    lines: [
      {
        product: 'phone-a05',
        phoneUnit: 'unit-a05-1',
        variant: 'a05-64',
        description: 'Samsung Galaxy A05 64GB',
        quantity: -1,
        unitPrice: 199_950,
        costPrice: 170_000,
        discount: -19_995,
      },
    ],
    invoiceDiscount: -500,
    payments: [{ method: 'cash' }],
  },
  {
    name: 'void-whole-sale',
    description: 'Void of the first cash sale',
    kind: 'void',
    original: 'cash-sale-simple',
    note: 'Entered by mistake',
    lines: [
      {
        product: 'charger',
        description: 'Fast charger 25W',
        quantity: -2,
        unitPrice: 50_000,
        costPrice: 32_000,
      },
    ],
    payments: [{ method: 'cash' }],
  },
  {
    name: 'urdu-text',
    description: 'Urdu description, note and payment reference (raw UTF-8, never \\u-escaped)',
    customer: 'customer-urdu',
    note: 'نقد ادائیگی، شکریہ! دوبارہ تشریف لائیں 🙏',
    lines: [
      {
        product: 'phone-redmi',
        phoneUnit: 'unit-redmi-1',
        description: 'ریڈمی نوٹ ۱۳ — ۱۲۸ جی بی (نیلا)',
        quantity: 1,
        unitPrice: 4_299_900,
        costPrice: 3_900_000,
      },
    ],
    payments: [
      { method: 'easypaisa', amount: 4_000_000, reference: 'ایزی پیسہ ۹۹۸۸' },
      { method: 'cash' },
    ],
  },
  {
    name: 'special-characters',
    description: 'Quotes, backslash, control chars, U+2028/2029, BOM, emoji (surrogate pairs, ZWJ)',
    note: SPECIAL_TEXT,
    lines: [
      {
        product: 'cable',
        description: 'Cable "USB-C" 1m \\ braided\n2nd line\t😀',
        quantity: 1,
        unitPrice: 79_900,
        costPrice: 40_000,
      },
    ],
    payments: [{ method: 'bank_transfer', reference: 'Ref "x" \\ <&> 🇵🇰' }],
  },
  {
    name: 'null-optional-fields',
    description:
      'Every nullable field null: no customer, note, original, phone unit, variant, reference',
    note: null,
    lines: [
      {
        product: 'screen-guard',
        description: 'Tempered glass',
        quantity: 5,
        unitPrice: 20_000,
        costPrice: 5_000,
      },
    ],
    payments: [{ method: 'cash', reference: null }],
  },
  {
    name: 'zero-total-no-payments',
    description: 'Invoice discount equals the subtotal: total 0, empty payments, empty-string note',
    note: '',
    lines: [
      {
        product: 'sim-tray',
        description: 'SIM ejector pin',
        quantity: 1,
        unitPrice: 5_000,
        costPrice: 500,
      },
    ],
    invoiceDiscount: 5_000,
    payments: [],
  },
  {
    name: 'large-amounts',
    description: 'Amounts above 2^31 and near 2^53 (must stay exact 64-bit integers)',
    lines: [
      {
        product: 'bulk',
        description: 'Bulk order',
        quantity: 1_000,
        unitPrice: 9_000_000_000_000,
        costPrice: 8_999_999_999_999,
        discount: 1,
      },
    ],
    payments: [{ method: 'bank_transfer', reference: 'IBAN PK36SCBL0000001123456702' }],
  },
  {
    name: 'chain-tail',
    description: 'Plain sale closing the chain (multi-line, many payment parts)',
    customer: 'customer-ali',
    lines: [
      { product: 'cover', description: 'Cover', quantity: 1, unitPrice: 45_000, costPrice: 15_000 },
      { product: 'cable', description: 'Cable', quantity: 2, unitPrice: 79_900, costPrice: 40_000 },
      {
        product: 'charger',
        description: 'Charger',
        quantity: 1,
        unitPrice: 50_000,
        costPrice: 32_000,
      },
    ],
    payments: [
      { method: 'cash', amount: 100_000 },
      { method: 'easypaisa', amount: 50_000, reference: 'EP-1' },
      { method: 'khata' },
    ],
  },
];

/** Builds the invoices in SPECS as one hash chain (one device, seq 1..n) and seals each with the TS code. */
export function buildInvoiceVectors(): InvoiceVector[] {
  let clock = BASE_TIME_MS;
  const nextId = createUuidV7Generator({ now: () => clock, randomBytes: seededBytes('invoices') });
  const named = new Map<string, string>();
  const idFor = (key: string): string => {
    const existing = named.get(key);
    if (existing !== undefined) return existing;
    const id = nextId();
    named.set(key, id);
    return id;
  };

  const deviceId = idFor('device');
  const branchId = idFor('branch');
  const cashierId = idFor('cashier');
  const saleIds = new Map<string, string>();
  const vectors: InvoiceVector[] = [];
  let prevHash = GENESIS_HASH;

  SPECS.forEach((spec, index) => {
    clock += STEP_MS;
    const seq = index + 1;
    const id = nextId();
    saleIds.set(spec.name, id);
    const createdAt = clock;

    const totals = saleTotals(
      spec.lines.map((l) => ({
        quantity: l.quantity,
        unitPrice: paisa(l.unitPrice),
        discountAmount: paisa(l.discount ?? 0),
      })),
      paisa(spec.invoiceDiscount ?? 0),
    );
    const lineDiscounts = spec.lines.reduce((sum, l) => sum + (l.discount ?? 0), 0);

    const lines: SaleLine[] = spec.lines.map((l, i) => ({
      id: nextId(),
      saleId: id,
      lineNo: i + 1,
      productId: idFor(l.product),
      phoneUnitId: l.phoneUnit === undefined ? null : idFor(l.phoneUnit),
      variantId: l.variant === undefined ? null : idFor(l.variant),
      description: l.description,
      quantity: l.quantity,
      unitPrice: paisa(l.unitPrice),
      costPrice: paisa(l.costPrice),
      discountAmount: paisa(l.discount ?? 0),
      lineTotal: totals.lineTotals[i] ?? paisa(0),
      createdAt,
    }));

    const explicit = spec.payments.reduce((sum, p) => sum + (p.amount ?? 0), 0);
    const payments: SalePayment[] = spec.payments.map((p) => ({
      id: nextId(),
      saleId: id,
      method: p.method,
      amount: paisa(p.amount ?? totals.total - explicit),
      reference: p.reference ?? null,
      createdAt,
    }));
    assertPaymentsMatchTotal(totals.total, payments);

    const original = spec.original === undefined ? null : saleIds.get(spec.original);
    if (original === undefined)
      throw new Error(`${spec.name}: unknown original ${String(spec.original)}`);

    const unsealed: UnsealedInvoice = {
      id,
      deviceId,
      seq,
      invoiceNo: formatInvoiceNo(INVOICE_PREFIX, seq),
      kind: spec.kind ?? 'sale',
      originalSaleId: original,
      branchId,
      customerId: spec.customer === undefined ? null : idFor(spec.customer),
      cashierId,
      subtotal: totals.subtotal,
      discountTotal: paisa(lineDiscounts + (spec.invoiceDiscount ?? 0)),
      total: totals.total,
      note: spec.note ?? null,
      createdAt,
      hashVersion: HASH_VERSION,
      lines: spec.reverseArrays === true ? [...lines].reverse() : lines,
      payments: spec.reverseArrays === true ? [...payments].reverse() : payments,
    };

    const expectedHash = computeInvoiceHash(prevHash, unsealed);
    vectors.push({
      name: spec.name,
      description: spec.description,
      previous_hash: prevHash,
      unsealed_data: unsealed,
      canonical: invoiceHashPayload(unsealed),
      expected_hash: expectedHash,
    });
    prevHash = expectedHash;
  });

  return vectors;
}
