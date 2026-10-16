import { GENESIS_HASH, InvoiceSchema, type Invoice, type UnsealedInvoice } from '@pos/shared';
import { sha256Hex } from '@pos/core';
import { camelizeKeys } from '../src/rows';
import { migrate } from '../src/migrate';
import { createNodeSqliteDriver, loadMigrationsFromDir, type NodeSqliteDriver } from '../src/node';
import type { SqlDriver, SqlValue, Statement } from '../src/types';
import { BASE_MS, FIXTURE_IDS, makeIdGenerator, makeInvoice } from '../../core/test/fixtures';

export type Row = Record<string, SqlValue>;

const gen = makeIdGenerator(31, BASE_MS + 500_000);
/** Fresh deterministic UUID v7 (unique within a test file). */
export const newId = (): string => gen();

/** Ids of the rows created by `seedShop`. The first seven match what `makeInvoice` references. */
export interface ShopIds {
  deviceId: string;
  branchId: string;
  branch2Id: string;
  cashierId: string;
  customerId: string;
  supplierId: string;
  productId: string; // the phone product
  accessoryProductId: string;
  phoneUnitId: string;
  variantId: string;
}

export const SHOP: ShopIds = {
  deviceId: FIXTURE_IDS.deviceId,
  branchId: FIXTURE_IDS.branchId,
  branch2Id: newId(),
  cashierId: FIXTURE_IDS.cashierId,
  customerId: FIXTURE_IDS.customerId,
  supplierId: newId(),
  productId: FIXTURE_IDS.productId,
  accessoryProductId: newId(),
  phoneUnitId: FIXTURE_IDS.phoneUnitId,
  variantId: FIXTURE_IDS.variantId,
};

export const IMEI_1 = '356938035643809';

// ---------------------------------------------------------------------------------------------
// Generic row helpers
// ---------------------------------------------------------------------------------------------

export function rowStatement(table: string, row: Row): Statement {
  const columns = Object.keys(row);
  return {
    sql: `insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    params: columns.map((c) => row[c] ?? null),
  };
}

export const insertRow = (db: SqlDriver, table: string, row: Row): Promise<void> =>
  db.batch([rowStatement(table, row)]);

export async function count(db: SqlDriver, table: string): Promise<number> {
  const rows = await db.query<{ n: number }>(`select count(*) as n from ${table}`);
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Row builders with valid defaults (override any column)
// ---------------------------------------------------------------------------------------------

export const movementRow = (over: Row = {}): Row => ({
  id: newId(),
  branch_id: SHOP.branchId,
  type: 'purchase',
  phone_unit_id: null,
  variant_id: SHOP.variantId,
  quantity: 1,
  unit_cost: null,
  ref_type: null,
  ref_id: null,
  reason: null,
  created_by: SHOP.cashierId,
  created_at: BASE_MS,
  ...over,
});

/** A raw `sales` header row: seq 1, genesis prev_hash, a unique hash derived from the id. */
export function saleRow(over: Row = {}): Row {
  const id = typeof over.id === 'string' ? over.id : newId();
  return {
    id,
    device_id: SHOP.deviceId,
    seq: 1,
    invoice_no: 'A-000001',
    kind: 'sale',
    original_sale_id: null,
    branch_id: SHOP.branchId,
    customer_id: SHOP.customerId,
    cashier_id: SHOP.cashierId,
    subtotal: 1000,
    discount_total: 0,
    total: 1000,
    note: null,
    created_at: BASE_MS,
    hash_version: 1,
    prev_hash: GENESIS_HASH,
    hash: sha256Hex(`row:${id}`),
    ...over,
  };
}

export const lineRow = (saleId: string, over: Row = {}): Row => ({
  id: newId(),
  sale_id: saleId,
  line_no: 1,
  product_id: SHOP.accessoryProductId,
  phone_unit_id: null,
  variant_id: SHOP.variantId,
  description: 'Fast Charger 25W',
  quantity: 1,
  unit_price: 1000,
  cost_price: 600,
  discount_amount: 0,
  line_total: 1000,
  created_at: BASE_MS,
  ...over,
});

export const paymentRow = (saleId: string, over: Row = {}): Row => ({
  id: newId(),
  sale_id: saleId,
  method: 'cash',
  amount: 1000,
  reference: null,
  created_at: BASE_MS,
  ...over,
});

export const ledgerRow = (over: Row = {}): Row => ({
  id: newId(),
  customer_id: SHOP.customerId,
  supplier_id: null,
  type: 'sale_credit',
  amount: 1000,
  method: null,
  sale_id: null,
  purchase_id: null,
  note: null,
  created_by: SHOP.cashierId,
  created_at: BASE_MS,
  ...over,
});

export const outboxRow = (over: Row = {}): Row => ({
  id: newId(),
  entity_type: 'sale',
  entity_id: newId(),
  op: 'insert',
  payload: '{"ok":true}',
  created_at: BASE_MS,
  attempts: 0,
  last_error: null,
  sent_at: null,
  ...over,
});

export const purchaseRow = (over: Row = {}): Row => ({
  id: newId(),
  supplier_id: SHOP.supplierId,
  branch_id: SHOP.branchId,
  kind: 'purchase',
  reference_no: 'INV-9001',
  total: 90_000,
  note: null,
  created_by: SHOP.cashierId,
  created_at: BASE_MS,
  ...over,
});

// ---------------------------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------------------------

/** Migrated, empty in-memory database. */
export async function createMigratedDb(filename = ':memory:'): Promise<NodeSqliteDriver> {
  const db = createNodeSqliteDriver(filename);
  await migrate(db, loadMigrationsFromDir());
  return db;
}

/**
 * Inserts the reference data every test needs: 2 branches, a cashier, a customer, a supplier,
 * a phone product with one IMEI unit (no stock yet), an accessory product with one variant.
 * The ids match `makeInvoice` / `buildChain` fixtures, so fixture invoices satisfy every foreign key.
 */
export async function seedShop(db: SqlDriver): Promise<ShopIds> {
  const now = BASE_MS;
  await db.batch([
    rowStatement('branches', { id: SHOP.branchId, name: 'Main Counter', created_at: now }),
    rowStatement('branches', { id: SHOP.branch2Id, name: 'Second Shop', created_at: now }),
    rowStatement('users', {
      id: SHOP.cashierId,
      username: 'ali',
      display_name: 'Ali (Cashier)',
      role: 'cashier',
      pin_hash: 'pin-hash',
      is_active: 1,
      created_at: now,
      updated_at: now,
    }),
    rowStatement('customers', {
      id: SHOP.customerId,
      name: 'Bilal Ahmed',
      phone: '03001234567',
      cnic: '3520112345671',
      credit_limit: 5_000_000,
      created_at: now,
      updated_at: now,
    }),
    rowStatement('suppliers', {
      id: SHOP.supplierId,
      name: 'Hafeez Centre Traders',
      phone: '03211234567',
      created_at: now,
      updated_at: now,
    }),
    rowStatement('products', {
      id: SHOP.productId,
      kind: 'phone',
      brand: 'Samsung',
      name: 'Galaxy A55 8/256',
      category: 'Smartphone',
      created_at: now,
      updated_at: now,
    }),
    rowStatement('products', {
      id: SHOP.accessoryProductId,
      kind: 'accessory',
      brand: 'Generic',
      name: 'Fast Charger 25W',
      category: 'Charger',
      created_at: now,
      updated_at: now,
    }),
    rowStatement('phone_units', {
      id: SHOP.phoneUnitId,
      product_id: SHOP.productId,
      imei1: IMEI_1,
      pta_status: 'approved',
      condition: 'new',
      cost_price: 7_800_000,
      sale_price: 8_500_000,
      supplier_id: SHOP.supplierId,
      created_at: now,
      updated_at: now,
    }),
    rowStatement('accessory_variants', {
      id: SHOP.variantId,
      product_id: SHOP.accessoryProductId,
      sku: 'CHG-25W-BLK',
      barcode: '8961234567890',
      model: 'Universal',
      colour: 'Black',
      cost_price: 90_000,
      sale_price: 150_000,
      reorder_level: 3,
      created_at: now,
      updated_at: now,
    }),
  ]);
  return SHOP;
}

/** Migrated in-memory database with `seedShop` applied. */
export async function createSeededDb(): Promise<{ db: NodeSqliteDriver; ids: ShopIds }> {
  const db = await createMigratedDb();
  const ids = await seedShop(db);
  return { db, ids };
}

/** Adds another accessory variant (for multi-item stock tests). */
export async function addVariant(db: SqlDriver, sku: string): Promise<string> {
  const id = newId();
  await insertRow(db, 'accessory_variants', {
    id,
    product_id: SHOP.accessoryProductId,
    sku,
    cost_price: 100,
    sale_price: 200,
    created_at: BASE_MS,
    updated_at: BASE_MS,
  });
  return id;
}

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

export interface InvoiceInsertOptions {
  /** Add a sale_credit / return_credit ledger entry for every khata payment (default true). */
  ledger?: boolean;
  /** Add one stock movement per line (default false). */
  movements?: boolean;
}

/** All statements needed to commit one invoice atomically (header, lines, payments, ledger, movements). */
export function invoiceStatements(inv: Invoice, options: InvoiceInsertOptions = {}): Statement[] {
  const { ledger = true, movements = false } = options;
  const statements: Statement[] = [
    rowStatement('sales', {
      id: inv.id,
      device_id: inv.deviceId,
      seq: inv.seq,
      invoice_no: inv.invoiceNo,
      kind: inv.kind,
      original_sale_id: inv.originalSaleId,
      branch_id: inv.branchId,
      customer_id: inv.customerId,
      cashier_id: inv.cashierId,
      subtotal: inv.subtotal,
      discount_total: inv.discountTotal,
      total: inv.total,
      note: inv.note,
      created_at: inv.createdAt,
      hash_version: inv.hashVersion,
      prev_hash: inv.prevHash,
      hash: inv.hash,
    }),
  ];
  for (const l of inv.lines) {
    statements.push(
      rowStatement('sale_lines', {
        id: l.id,
        sale_id: l.saleId,
        line_no: l.lineNo,
        product_id: l.productId,
        phone_unit_id: l.phoneUnitId,
        variant_id: l.variantId,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        cost_price: l.costPrice,
        discount_amount: l.discountAmount,
        line_total: l.lineTotal,
        created_at: l.createdAt,
      }),
    );
    if (movements) {
      statements.push(
        rowStatement(
          'stock_movements',
          movementRow({
            type: inv.kind === 'sale' ? 'sale' : 'return',
            branch_id: inv.branchId,
            phone_unit_id: l.phoneUnitId,
            variant_id: l.variantId,
            quantity: -l.quantity,
            ref_type: 'sale',
            ref_id: inv.id,
            created_by: inv.cashierId,
            created_at: l.createdAt,
          }),
        ),
      );
    }
  }
  for (const p of inv.payments) {
    statements.push(
      rowStatement('payments', {
        id: p.id,
        sale_id: p.saleId,
        method: p.method,
        amount: p.amount,
        reference: p.reference,
        created_at: p.createdAt,
      }),
    );
    if (ledger && p.method === 'khata' && inv.customerId !== null) {
      statements.push(
        rowStatement(
          'ledger_entries',
          ledgerRow({
            customer_id: inv.customerId,
            type: inv.kind === 'sale' ? 'sale_credit' : 'return_credit',
            amount: p.amount,
            sale_id: inv.id,
            created_by: inv.cashierId,
            created_at: p.createdAt,
          }),
        ),
      );
    }
  }
  return statements;
}

export const insertInvoice = (
  db: SqlDriver,
  inv: Invoice,
  options?: InvoiceInsertOptions,
): Promise<void> => db.batch(invoiceStatements(inv, options));

export async function insertInvoices(
  db: SqlDriver,
  invoices: readonly Invoice[],
  options?: InvoiceInsertOptions,
): Promise<void> {
  for (const inv of invoices) await insertInvoice(db, inv, options);
}

/** The reversal of `original`: same lines/payments with every quantity and amount negated. */
export function makeReturnUnsealed(
  original: Invoice | UnsealedInvoice,
  over: Partial<UnsealedInvoice> = {},
): UnsealedInvoice {
  const id = over.id ?? (newId() as UnsealedInvoice['id']);
  const base = makeInvoice({ id });
  const negate = <T extends number>(n: T): T => (n === 0 ? n : (-n as T));
  const unsealed = {
    ...base,
    kind: 'return',
    originalSaleId: original.id,
    subtotal: negate(original.subtotal),
    discountTotal: negate(original.discountTotal),
    total: negate(original.total),
    lines: original.lines.map((l, i) => ({
      ...l,
      id: newId(),
      saleId: id,
      lineNo: i + 1,
      quantity: -l.quantity,
      discountAmount: negate(l.discountAmount),
      lineTotal: negate(l.lineTotal),
    })),
    payments: original.payments.map((p) => ({
      ...p,
      id: newId(),
      saleId: id,
      amount: negate(p.amount),
    })),
    ...over,
  } as unknown as UnsealedInvoice;
  return unsealed;
}

/** Loads every invoice (header + lines + payments) from SQLite and runs it through InvoiceSchema. */
export async function readInvoices(db: SqlDriver): Promise<Invoice[]> {
  const sales = await db.query<Record<string, unknown>>('select * from sales order by seq');
  const out: Invoice[] = [];
  for (const row of sales) {
    const lines = await db.query<Record<string, unknown>>(
      'select * from sale_lines where sale_id = ? order by line_no',
      [row.id as string],
    );
    const payments = await db.query<Record<string, unknown>>(
      'select * from payments where sale_id = ? order by created_at, id',
      [row.id as string],
    );
    out.push(
      InvoiceSchema.parse({
        ...camelizeKeys<Record<string, unknown>>(row),
        lines: lines.map((l) => camelizeKeys<Record<string, unknown>>(l)),
        payments: payments.map((p) => camelizeKeys<Record<string, unknown>>(p)),
      }),
    );
  }
  return out;
}

/** Puts one handset into stock at the given branch. */
export async function receivePhone(
  db: SqlDriver,
  unitId: string = SHOP.phoneUnitId,
  branchId: string = SHOP.branchId,
): Promise<void> {
  await insertRow(
    db,
    'stock_movements',
    movementRow({
      type: 'purchase',
      phone_unit_id: unitId,
      variant_id: null,
      quantity: 1,
      branch_id: branchId,
    }),
  );
}
