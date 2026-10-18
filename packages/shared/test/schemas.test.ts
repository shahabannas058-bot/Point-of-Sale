import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CnicSchema,
  CustomerSchema,
  GENESIS_HASH,
  ImeiSchema,
  InvoiceSchema,
  LedgerEntrySchema,
  OutboxEntrySchema,
  PaisaSchema,
  PhoneNumberSchema,
  PhoneUnitSchema,
  PurchaseSchema,
  SaleSchema,
  Sha256HexSchema,
  StockMovementSchema,
  UserSchema,
  UuidV7Schema,
} from '@pos/shared';

/** Deterministic, well-formed lowercase UUID v7 literals. */
const uid = (n: number): string => `01993a00-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = 1_760_000_000_000;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const clone = <T>(value: T): T => structuredClone(value);

/** Parses and returns the issue messages (empty array = accepted). */
function issues(schema: z.ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}
function expectAccepted(schema: z.ZodTypeAny, value: unknown): void {
  expect(issues(schema, value)).toEqual([]);
}
function expectRejected(schema: z.ZodTypeAny, value: unknown, messagePart?: string): void {
  const found = issues(schema, value);
  expect(found.length, 'expected the value to be rejected').toBeGreaterThan(0);
  if (messagePart !== undefined) expect(found.join(' | ')).toContain(messagePart);
}

describe('primitives', () => {
  it('UuidV7Schema accepts v7 and rejects v4 and uppercase', () => {
    expectAccepted(UuidV7Schema, uid(1));
    expectRejected(UuidV7Schema, '3f2b8c1e-9a4d-4e6b-8c1d-2f3a4b5c6d7e');
    expectRejected(UuidV7Schema, uid(1).toUpperCase());
    expectRejected(UuidV7Schema, '01993a00-0000-7000-c000-000000000001'); // bad variant nibble
    expectRejected(UuidV7Schema, 42);
  });

  it('PaisaSchema accepts signed safe integers only', () => {
    expectAccepted(PaisaSchema, 0);
    expectAccepted(PaisaSchema, -199950);
    expectRejected(PaisaSchema, 1.5);
    expectRejected(PaisaSchema, 2 ** 53);
    expectRejected(PaisaSchema, Number.NaN);
    expectRejected(PaisaSchema, '100');
  });

  it('ImeiSchema needs exactly 15 digits', () => {
    expectAccepted(ImeiSchema, '356938035643809');
    expectRejected(ImeiSchema, '35693803564380'); // 14 digits
    expectRejected(ImeiSchema, '3569380356438090'); // 16 digits
    expectRejected(ImeiSchema, '12345678901234a');
  });

  it('CnicSchema, PhoneNumberSchema and Sha256HexSchema', () => {
    expectAccepted(CnicSchema, '3520112345671');
    expectRejected(CnicSchema, '35201-1234567-1');
    expectAccepted(PhoneNumberSchema, '03001234567');
    expectAccepted(PhoneNumberSchema, '+923001234567');
    expectRejected(PhoneNumberSchema, '0300-1234567');
    expectAccepted(Sha256HexSchema, GENESIS_HASH);
    expectRejected(Sha256HexSchema, 'A'.repeat(64));
    expectRejected(Sha256HexSchema, 'a'.repeat(63));
  });
});

describe('people', () => {
  const user = {
    id: uid(10),
    username: 'ali.khan',
    displayName: 'Ali Khan',
    role: 'cashier',
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('UserSchema accepts a valid user and rejects bad roles and usernames', () => {
    expectAccepted(UserSchema, user);
    expectRejected(UserSchema, { ...user, role: 'admin' });
    expectRejected(UserSchema, { ...user, username: 'Ali' });
    expectRejected(UserSchema, { ...user, username: 'al' });
  });

  it('CustomerSchema validates CNIC, phone and credit limit', () => {
    const customer = {
      id: uid(11),
      name: 'Bilal Ahmed',
      phone: '03001234567',
      cnic: '3520112345671',
      address: null,
      creditLimit: 5_000_000,
      notes: null,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expectAccepted(CustomerSchema, customer);
    expectAccepted(CustomerSchema, { ...customer, creditLimit: null, phone: null, cnic: null });
    expectRejected(CustomerSchema, { ...customer, creditLimit: -1 });
    expectRejected(CustomerSchema, { ...customer, cnic: '123' });
  });
});

describe('PhoneUnitSchema', () => {
  const unit = {
    id: uid(20),
    productId: uid(21),
    imei1: '356938035643809',
    imei2: '356938035643817',
    serial: null,
    colour: 'Black',
    storageGb: 256,
    ramGb: 8,
    batteryHealthPct: null,
    ptaStatus: 'approved',
    condition: 'new',
    costPrice: 7_800_000,
    salePrice: 8_500_000,
    supplierId: null,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('accepts a dual-SIM unit and a serial-only unit', () => {
    expectAccepted(PhoneUnitSchema, unit);
    expectAccepted(PhoneUnitSchema, { ...unit, imei1: null, imei2: null, serial: 'SN-001' });
  });

  it('needs imei1 or serial', () => {
    expectRejected(
      PhoneUnitSchema,
      { ...unit, imei1: null, imei2: null, serial: null },
      'imei1 or serial',
    );
  });

  it('rejects imei2 equal to imei1', () => {
    expectRejected(PhoneUnitSchema, { ...unit, imei2: unit.imei1 }, 'must differ');
  });

  it('rejects imei2 without imei1', () => {
    expectRejected(PhoneUnitSchema, { ...unit, imei1: null, serial: 'SN-001' }, 'imei2 requires');
  });

  it('rejects out-of-range battery health, unknown PTA status and negative prices', () => {
    expectRejected(PhoneUnitSchema, { ...unit, batteryHealthPct: 101 });
    expectRejected(PhoneUnitSchema, { ...unit, ptaStatus: 'banned' });
    expectRejected(PhoneUnitSchema, { ...unit, costPrice: -1 });
  });
});

describe('StockMovementSchema', () => {
  const movement = {
    id: uid(30),
    branchId: uid(31),
    type: 'purchase',
    phoneUnitId: null,
    variantId: uid(32),
    quantity: 10,
    unitCost: 90_000,
    refType: null,
    refId: null,
    reason: null,
    createdBy: uid(33),
    createdAt: NOW,
  };

  it('accepts a purchase, a sale, and a phone-unit movement', () => {
    expectAccepted(StockMovementSchema, movement);
    expectAccepted(StockMovementSchema, { ...movement, type: 'sale', quantity: -2 });
    expectAccepted(StockMovementSchema, {
      ...movement,
      type: 'purchase',
      variantId: null,
      phoneUnitId: uid(34),
      quantity: 1,
    });
  });

  it('rejects a sale with a positive quantity', () => {
    expectRejected(StockMovementSchema, { ...movement, type: 'sale', quantity: 1 }, 'negative');
  });

  it('rejects a purchase with a negative quantity and a zero quantity', () => {
    expectRejected(StockMovementSchema, { ...movement, quantity: -1 }, 'positive');
    expectRejected(StockMovementSchema, { ...movement, quantity: 0 }, 'zero');
  });

  it('rejects a phone unit with quantity 2', () => {
    expectRejected(
      StockMovementSchema,
      { ...movement, variantId: null, phoneUnitId: uid(34), quantity: 2 },
      'one at a time',
    );
  });

  it('rejects both or neither of phoneUnitId / variantId', () => {
    expectRejected(
      StockMovementSchema,
      { ...movement, phoneUnitId: uid(34), quantity: 1 },
      'Exactly one',
    );
    expectRejected(StockMovementSchema, { ...movement, variantId: null }, 'Exactly one');
  });

  it('rejects an adjustment without a reason, accepts it with one', () => {
    const adjustment = { ...movement, type: 'adjustment', quantity: -1 };
    expectRejected(StockMovementSchema, adjustment, 'reason');
    expectAccepted(StockMovementSchema, { ...adjustment, reason: 'damaged in transit' });
  });

  it('rejects a transfer without refType transfer', () => {
    const transfer = { ...movement, type: 'transfer', quantity: -4 };
    expectRejected(StockMovementSchema, transfer, "refType 'transfer'");
    expectRejected(StockMovementSchema, { ...transfer, refType: 'sale', refId: uid(35) });
    expectAccepted(StockMovementSchema, { ...transfer, refType: 'transfer', refId: uid(35) });
  });

  it('rejects refType without refId and vice versa', () => {
    expectRejected(StockMovementSchema, { ...movement, refType: 'purchase' }, 'both be set');
    expectRejected(StockMovementSchema, { ...movement, refId: uid(35) }, 'both be set');
  });
});

describe('PurchaseSchema', () => {
  const purchase = {
    id: uid(40),
    supplierId: uid(41),
    branchId: uid(42),
    kind: 'purchase',
    referenceNo: 'INV-9001',
    total: 8_700_000,
    note: null,
    createdBy: uid(43),
    createdAt: NOW,
  };

  it('enforces the sign by kind', () => {
    expectAccepted(PurchaseSchema, purchase);
    expectAccepted(PurchaseSchema, { ...purchase, kind: 'return', total: -90_000 });
    expectRejected(PurchaseSchema, { ...purchase, total: -1 }, 'negative');
    expectRejected(PurchaseSchema, { ...purchase, kind: 'return', total: 1 }, 'positive');
  });
});

describe('Invoice schemas', () => {
  const SALE = uid(50);
  /** One accessory line of 150000, paid half cash and half khata. */
  const sale = {
    id: SALE,
    deviceId: uid(51),
    seq: 1,
    invoiceNo: 'A-000001',
    kind: 'sale',
    originalSaleId: null as string | null,
    branchId: uid(52),
    customerId: uid(53),
    cashierId: uid(54),
    subtotal: 150000,
    discountTotal: 0,
    total: 150000,
    note: null,
    createdAt: NOW,
    hashVersion: 1,
    prevHash: GENESIS_HASH,
    hash: HASH_A,
    lines: [
      {
        id: uid(55),
        saleId: SALE,
        lineNo: 1,
        productId: uid(56),
        phoneUnitId: null,
        variantId: uid(57),
        description: 'Fast Charger 25W',
        quantity: 1,
        unitPrice: 150000,
        costPrice: 90000,
        discountAmount: 0,
        lineTotal: 150000,
        createdAt: NOW,
      },
    ],
    payments: [
      {
        id: uid(58),
        saleId: SALE,
        method: 'cash',
        amount: 100000,
        reference: null,
        createdAt: NOW,
      },
      {
        id: uid(59),
        saleId: SALE,
        method: 'khata',
        amount: 50000,
        reference: null,
        createdAt: NOW,
      },
    ],
  };

  /** The matching return: negative quantities, amounts and refunds. */
  const returnInvoice = (() => {
    const r = clone(sale) as Record<string, unknown> & typeof sale;
    r.id = uid(60);
    r.seq = 2;
    r.invoiceNo = 'A-000002';
    r.kind = 'return';
    r.originalSaleId = SALE;
    r.subtotal = -150000;
    r.total = -150000;
    r.prevHash = HASH_A;
    r.hash = HASH_B;
    r.lines = [
      { ...sale.lines[0]!, id: uid(61), saleId: uid(60), quantity: -1, lineTotal: -150000 },
    ];
    r.payments = [{ ...sale.payments[0]!, id: uid(62), saleId: uid(60), amount: -150000 }];
    return r;
  })();

  it('accepts a valid sale and a valid return', () => {
    expectAccepted(InvoiceSchema, sale);
    expectAccepted(InvoiceSchema, returnInvoice);
  });

  it('rejects payments that sum to 149999 against a total of 150000', () => {
    const bad = clone(sale);
    bad.payments[1]!.amount = 49999;
    expectRejected(InvoiceSchema, bad, 'sum exactly');
  });

  it('rejects a khata payment with customerId null', () => {
    const bad = clone(sale) as Record<string, unknown> & typeof sale;
    bad.customerId = null as unknown as string;
    expectRejected(InvoiceSchema, bad, 'Khata payment requires a customer');
  });

  it('rejects a lineTotal that does not match quantity x unitPrice - discount', () => {
    const bad = clone(sale);
    bad.lines[0]!.lineTotal = 149999;
    expectRejected(InvoiceSchema, bad, 'lineTotal must equal');
  });

  it('rejects a return with a positive quantity', () => {
    const bad = clone(returnInvoice) as typeof sale;
    bad.lines[0]!.quantity = 1;
    expectRejected(InvoiceSchema, bad, 'negative');
  });

  it('rejects a return with originalSaleId null', () => {
    const bad = clone(returnInvoice) as Record<string, unknown>;
    bad.originalSaleId = null;
    expectRejected(InvoiceSchema, bad, 'original sale');
    expectRejected(SaleSchema, bad, 'original sale');
  });

  it('rejects a subtotal that is not the sum of the lines', () => {
    const bad = clone(sale);
    bad.subtotal = 150001;
    bad.total = 150001;
    bad.payments[1]!.amount = 50001;
    expectRejected(InvoiceSchema, bad, 'sum of line totals');
  });

  it('rejects a sale that references an original sale', () => {
    const bad = clone(sale) as Record<string, unknown>;
    bad.originalSaleId = uid(99);
    expectRejected(InvoiceSchema, bad, 'cannot reference an original sale');
  });

  it('rejects total <> subtotal - discountTotal', () => {
    const bad = clone(sale);
    bad.discountTotal = 1000;
    expectRejected(InvoiceSchema, bad, 'total must equal subtotal - discountTotal');
  });

  it('rejects an invoice with no lines, a hashVersion other than 1 or 2, and a bad hash', () => {
    expectRejected(InvoiceSchema, { ...sale, lines: [] });
    expectRejected(InvoiceSchema, { ...sale, hashVersion: 3 });
    expectRejected(InvoiceSchema, { ...sale, hash: 'xyz' });
  });

  it('rejects lines or payments that belong to another sale', () => {
    const lineBad = clone(sale);
    lineBad.lines[0]!.saleId = uid(98);
    expectRejected(InvoiceSchema, lineBad, 'another sale');
    const payBad = clone(sale);
    payBad.payments[0]!.saleId = uid(98);
    expectRejected(InvoiceSchema, payBad, 'another sale');
  });

  it('rejects a phone-unit line with quantity 2 and a line with both unit and variant', () => {
    const phoneBad = clone(sale);
    phoneBad.lines[0]!.variantId = null as unknown as string;
    (phoneBad.lines[0] as Record<string, unknown>).phoneUnitId = uid(70);
    phoneBad.lines[0]!.quantity = 2;
    phoneBad.lines[0]!.unitPrice = 75000;
    phoneBad.lines[0]!.lineTotal = 150000;
    expectRejected(InvoiceSchema, phoneBad, 'one at a time');

    const both = clone(sale);
    (both.lines[0] as Record<string, unknown>).phoneUnitId = uid(70);
    expectRejected(InvoiceSchema, both, 'Exactly one');
  });

  it('rejects a payment of zero and a wrong-sign payment', () => {
    const zero = clone(sale);
    zero.payments[1]!.amount = 0;
    expectRejected(InvoiceSchema, zero, 'cannot be zero');
    const refund = clone(sale);
    refund.payments[0]!.amount = -100000;
    expectRejected(InvoiceSchema, refund, 'sign');
  });

  it('rejects a return whose amounts are positive', () => {
    const bad = clone(returnInvoice) as Record<string, unknown>;
    bad.subtotal = 150000;
    bad.total = 150000;
    expectRejected(InvoiceSchema, bad);
  });
});

describe('LedgerEntrySchema', () => {
  const entry = {
    id: uid(80),
    customerId: uid(81),
    supplierId: null,
    type: 'sale_credit',
    amount: 150000,
    method: null,
    saleId: uid(82),
    purchaseId: null,
    note: null,
    createdBy: uid(83),
    createdAt: NOW,
  };

  it('accepts customer and supplier entries', () => {
    expectAccepted(LedgerEntrySchema, entry);
    expectAccepted(LedgerEntrySchema, {
      ...entry,
      type: 'payment_received',
      amount: -50000,
      method: 'cash',
      saleId: null,
    });
    expectAccepted(LedgerEntrySchema, {
      ...entry,
      customerId: null,
      supplierId: uid(84),
      type: 'purchase_credit',
      amount: 90000,
    });
  });

  it('rejects a payment_received with a positive amount', () => {
    expectRejected(
      LedgerEntrySchema,
      { ...entry, type: 'payment_received', amount: 50000 },
      'must be negative',
    );
  });

  it('rejects a sale_credit for a supplier', () => {
    expectRejected(
      LedgerEntrySchema,
      { ...entry, customerId: null, supplierId: uid(84) },
      'not valid for a supplier',
    );
  });

  it('rejects both parties set or neither', () => {
    expectRejected(LedgerEntrySchema, { ...entry, supplierId: uid(84) }, 'Exactly one');
    expectRejected(LedgerEntrySchema, { ...entry, customerId: null }, 'Exactly one');
  });

  it("rejects method 'khata' and a zero amount", () => {
    expectRejected(LedgerEntrySchema, { ...entry, method: 'khata' });
    expectRejected(LedgerEntrySchema, { ...entry, amount: 0 });
  });

  it('rejects a purchase_credit for a customer', () => {
    expectRejected(
      LedgerEntrySchema,
      { ...entry, type: 'purchase_credit' },
      'not valid for a customer',
    );
  });
});

describe('OutboxEntrySchema', () => {
  const outbox = {
    id: uid(90),
    entityType: 'sale',
    entityId: uid(91),
    op: 'insert',
    payload: '{"id":"x"}',
    createdAt: NOW,
    attempts: 0,
    lastError: null,
    sentAt: null,
  };

  it('accepts a pending entry and rejects bad ops, entity types and attempts', () => {
    expectAccepted(OutboxEntrySchema, outbox);
    expectAccepted(OutboxEntrySchema, {
      ...outbox,
      attempts: 3,
      lastError: 'timeout',
      sentAt: NOW,
    });
    expectRejected(OutboxEntrySchema, { ...outbox, op: 'delete' });
    expectRejected(OutboxEntrySchema, { ...outbox, entityType: 'invoice' });
    expectRejected(OutboxEntrySchema, { ...outbox, attempts: -1 });
    expectRejected(OutboxEntrySchema, { ...outbox, payload: '' });
  });
});
