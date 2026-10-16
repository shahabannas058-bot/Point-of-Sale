import { expect } from 'vitest';
import { GENESIS_HASH, InvoiceSchema, type Invoice, type UnsealedInvoice } from '@pos/shared';
import {
  createUuidV7Generator,
  DomainError,
  sealInvoice,
  type DomainErrorCode,
  type RandomBytes,
} from '@pos/core';

/** Small deterministic PRNG (mulberry32). Same seed, same sequence, on every machine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max], inclusive. */
export const randInt = (rand: () => number, min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));

/** Deterministic `randomBytes` for the UUID v7 generator. */
export function seededRandomBytes(seed: number): RandomBytes {
  const rand = mulberry32(seed);
  return (length) => Uint8Array.from({ length }, () => Math.floor(rand() * 256));
}

export const BASE_MS = 1_760_000_000_000;

/** UUID v7 generator with injected, deterministic clock (+1 ms per call) and random bytes. */
export function makeIdGenerator(seed = 1, startMs = BASE_MS): () => string {
  let ms = startMs;
  return createUuidV7Generator({
    now: () => ms++,
    randomBytes: seededRandomBytes(seed),
  });
}

/** Asserts that `fn` throws a DomainError with the given code; returns it for message checks. */
export function expectDomainError(fn: () => unknown, code: DomainErrorCode): DomainError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected DomainError ${code}`).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
  return caught as DomainError;
}

const fixtureIdGen = makeIdGenerator(7);
const castId = <T>(): T => fixtureIdGen() as unknown as T;

type Ids = {
  deviceId: UnsealedInvoice['deviceId'];
  branchId: UnsealedInvoice['branchId'];
  cashierId: UnsealedInvoice['cashierId'];
  customerId: NonNullable<UnsealedInvoice['customerId']>;
  productId: UnsealedInvoice['lines'][number]['productId'];
  phoneUnitId: NonNullable<UnsealedInvoice['lines'][number]['phoneUnitId']>;
  variantId: NonNullable<UnsealedInvoice['lines'][number]['variantId']>;
};

/** Stable ids shared by every fixture invoice (the db helpers seed exactly these rows). */
export const FIXTURE_IDS: Ids = {
  deviceId: castId(),
  branchId: castId(),
  cashierId: castId(),
  customerId: castId(),
  productId: castId(),
  phoneUnitId: castId(),
  variantId: castId(),
};

const invoiceIdGen = makeIdGenerator(11, BASE_MS + 10_000);

/**
 * A valid sale: 2 accessory units at 50000 plus one phone at 199950 less 19995 discount.
 * subtotal = total = 279955; paid 179955 cash + 100000 khata (customer set).
 * Pass overrides for header fields; lines/payments are rebuilt around the (possibly overridden) id.
 */
export function makeInvoice(overrides: Partial<UnsealedInvoice> = {}): UnsealedInvoice {
  const id = overrides.id ?? (invoiceIdGen() as unknown as UnsealedInvoice['id']);
  const createdAt = overrides.createdAt ?? (BASE_MS as UnsealedInvoice['createdAt']);
  const lines = [
    {
      id: invoiceIdGen(),
      saleId: id,
      lineNo: 1,
      productId: FIXTURE_IDS.productId,
      phoneUnitId: null,
      variantId: FIXTURE_IDS.variantId,
      description: 'Fast Charger 25W',
      quantity: 2,
      unitPrice: 50000,
      costPrice: 30000,
      discountAmount: 0,
      lineTotal: 100000,
      createdAt,
    },
    {
      id: invoiceIdGen(),
      saleId: id,
      lineNo: 2,
      productId: FIXTURE_IDS.productId,
      phoneUnitId: FIXTURE_IDS.phoneUnitId,
      variantId: null,
      description: 'Galaxy A55 8/256',
      quantity: 1,
      unitPrice: 199950,
      costPrice: 150000,
      discountAmount: 19995,
      lineTotal: 179955,
      createdAt,
    },
  ];
  const payments = [
    {
      id: invoiceIdGen(),
      saleId: id,
      method: 'cash',
      amount: 179955,
      reference: null,
      createdAt,
    },
    {
      id: invoiceIdGen(),
      saleId: id,
      method: 'khata',
      amount: 100000,
      reference: null,
      createdAt,
    },
  ];
  const base = {
    id,
    deviceId: FIXTURE_IDS.deviceId,
    seq: 1,
    invoiceNo: 'A-000001',
    kind: 'sale',
    originalSaleId: null,
    branchId: FIXTURE_IDS.branchId,
    customerId: FIXTURE_IDS.customerId,
    cashierId: FIXTURE_IDS.cashierId,
    subtotal: 279955,
    discountTotal: 0,
    total: 279955,
    note: null,
    createdAt,
    hashVersion: 1,
    lines,
    payments,
  };
  return { ...base, ...overrides } as unknown as UnsealedInvoice;
}

/** Seals `n` invoices from GENESIS_HASH (seq 1..n, 1 s apart) and runs each through InvoiceSchema. */
export function buildChain(n: number, deviceId: Ids['deviceId'] = FIXTURE_IDS.deviceId): Invoice[] {
  const chain: Invoice[] = [];
  let prev: string = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const seq = i + 1;
    const unsealed = makeInvoice({
      deviceId,
      seq,
      invoiceNo: `A-${String(seq).padStart(6, '0')}`,
      createdAt: (BASE_MS + i * 1000) as UnsealedInvoice['createdAt'],
    });
    const invoice = InvoiceSchema.parse(sealInvoice(prev, unsealed));
    chain.push(invoice);
    prev = invoice.hash;
  }
  return chain;
}
