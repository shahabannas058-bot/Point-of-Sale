import {
  InvoiceSchema,
  ServiceError,
  type Invoice,
  type LedgerEntryType,
  type PaymentMethod,
  type Role,
  type StockMovementType,
  type StockRefType,
  type UnitLabel,
  type UnitScale,
  type ItemView,
} from '@pos/shared';
import { camelizeKeys } from '../rows';
import type { SqlDriver, SqlValue } from '../types';
import type { WriteBatch } from './batch';
import { mapRow, toItemView, type Raw } from './mappers';

// ---------- read SQL ----------
const PRODUCT_COLS = `p.brand AS p_brand, p.name AS p_name, p.category AS p_category,
  p.is_active AS p_is_active, p.created_at AS p_created_at, p.updated_at AS p_updated_at`;

/** One item + its product + on-hand in a branch. The FIRST bind param is the branch id. */
export const ITEM_VIEW_SQL = `SELECT it.*, ${PRODUCT_COLS},
  COALESCE((SELECT SUM(sm.quantity) FROM stock_movements sm WHERE sm.item_id = it.id AND sm.branch_id = ?), 0) AS on_hand
  FROM items it JOIN products p ON p.id = it.product_id`;

export const USER_COLS = 'id, username, display_name, role, is_active, created_at, updated_at';

/** Escapes % _ \ for LIKE ... ESCAPE '\'. */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function loadItemView(
  driver: SqlDriver,
  id: string,
  branchId: string,
): Promise<ItemView | null> {
  const rows = await driver.query<Raw>(`${ITEM_VIEW_SQL} WHERE it.id = ?`, [branchId, id]);
  const row = rows[0];
  return row === undefined ? null : toItemView(row);
}

export async function requireItemView(
  driver: SqlDriver,
  id: string,
  branchId: string,
): Promise<ItemView> {
  const v = await loadItemView(driver, id, branchId);
  if (v === null) throw new ServiceError('NOT_FOUND', 'Item not found', { id });
  return v;
}

export async function itemOnHand(
  driver: SqlDriver,
  itemId: string,
  branchId: string,
): Promise<number> {
  const rows = await driver.query<{ n: number }>(
    'SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_movements WHERE item_id = ? AND branch_id = ?',
    [itemId, branchId],
  );
  return rows[0]?.n ?? 0;
}

export async function customerBalance(driver: SqlDriver, customerId: string): Promise<number> {
  const rows = await driver.query<{ n: number }>(
    'SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE customer_id = ?',
    [customerId],
  );
  return rows[0]?.n ?? 0;
}

export async function supplierBalance(driver: SqlDriver, supplierId: string): Promise<number> {
  const rows = await driver.query<{ n: number }>(
    'SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE supplier_id = ?',
    [supplierId],
  );
  return rows[0]?.n ?? 0;
}

export interface HeadRow {
  seq: number;
  hash: string;
  createdAt: number;
}
export async function loadHead(driver: SqlDriver, deviceId: string): Promise<HeadRow | null> {
  const rows = await driver.query<{ seq: number; hash: string; created_at: number }>(
    'SELECT seq, hash, created_at FROM sales WHERE device_id = ? ORDER BY seq DESC LIMIT 1',
    [deviceId],
  );
  const r = rows[0];
  return r === undefined ? null : { seq: r.seq, hash: r.hash, createdAt: r.created_at };
}

// ---------- invoices ----------
export function assembleInvoiceInput(
  sale: Raw,
  lines: readonly Raw[],
  payments: readonly Raw[],
): Raw {
  return {
    ...camelizeKeys<Raw>(sale),
    lines: lines.map((l) => camelizeKeys<Raw>(l)),
    payments: payments.map((p) => camelizeKeys<Raw>(p)),
  };
}

export async function loadInvoiceBy(
  driver: SqlDriver,
  column: 'id' | 'invoice_no',
  value: string,
): Promise<Invoice | null> {
  const sales = await driver.query<Raw>(`SELECT * FROM sales WHERE ${column} = ?`, [value]);
  const sale = sales[0];
  if (sale === undefined) return null;
  const id = sale.id as string;
  const lines = await driver.query<Raw>(
    'SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY line_no',
    [id],
  );
  const payments = await driver.query<Raw>('SELECT * FROM payments WHERE sale_id = ? ORDER BY id', [
    id,
  ]);
  return InvoiceSchema.parse(assembleInvoiceInput(sale, lines, payments));
}

export async function requireInvoice(driver: SqlDriver, idOrNo: string): Promise<Invoice> {
  const byId = await loadInvoiceBy(driver, 'id', idOrNo);
  if (byId !== null) return byId;
  const byNo = await loadInvoiceBy(driver, 'invoice_no', idOrNo);
  if (byNo === null) throw new ServiceError('NOT_FOUND', 'Invoice not found', { id: idOrNo });
  return byNo;
}

export async function saleExists(driver: SqlDriver, id: string): Promise<boolean> {
  const rows = await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM sales WHERE id = ?', [
    id,
  ]);
  return (rows[0]?.n ?? 0) > 0;
}

// ---------- plain records (what is inserted AND what is emitted to the outbox) ----------
/**
 * Legacy constant stored in products.kind (its CHECK still allows the mobile-shop value 'phone', which migration
 * 0009 refuses). Every product row is written with it; it is not part of the public contract.
 */
export const LEGACY_PRODUCT_KIND = 'accessory';
export interface ProductRec {
  id: string;
  kind: typeof LEGACY_PRODUCT_KIND;
  brand: string;
  name: string;
  category: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}
export function insertProduct(b: WriteBatch, p: ProductRec): void {
  b.add(
    'INSERT INTO products (id, kind, brand, name, category, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [p.id, p.kind, p.brand, p.name, p.category, p.isActive ? 1 : 0, p.createdAt, p.updatedAt],
  ).emit('product', p.id, 'insert', p);
}

export interface ItemRec {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  model: string | null;
  colour: string | null;
  costPrice: number;
  salePrice: number;
  reorderLevel: number;
  unitScale: UnitScale;
  unitLabel: UnitLabel;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}
export function insertItem(b: WriteBatch, v: ItemRec): void {
  b.add(
    `INSERT INTO items (id, product_id, sku, barcode, model, colour, cost_price, sale_price,
       reorder_level, unit_scale, unit_label, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      v.id,
      v.productId,
      v.sku,
      v.barcode,
      v.model,
      v.colour,
      v.costPrice,
      v.salePrice,
      v.reorderLevel,
      v.unitScale,
      v.unitLabel,
      v.isActive ? 1 : 0,
      v.createdAt,
      v.updatedAt,
    ],
  ).emit('item', v.id, 'insert', v);
}
export function updateItem(b: WriteBatch, v: ItemRec): void {
  b.add(
    `UPDATE items SET barcode = ?, model = ?, colour = ?, cost_price = ?, sale_price = ?,
       reorder_level = ?, updated_at = ? WHERE id = ?`,
    [v.barcode, v.model, v.colour, v.costPrice, v.salePrice, v.reorderLevel, v.updatedAt, v.id],
  ).emit('item', v.id, 'update', v);
}
export async function loadItemRec(driver: SqlDriver, id: string): Promise<ItemRec> {
  const rows = await driver.query<Raw>('SELECT * FROM items WHERE id = ?', [id]);
  const row = rows[0];
  if (row === undefined) throw new ServiceError('NOT_FOUND', 'Item not found', { id });
  return mapRow<ItemRec>(row);
}

export interface CustomerRec {
  id: string;
  name: string;
  phone: string | null;
  cnic: string | null;
  address: string | null;
  creditLimit: number | null;
  notes: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}
export function insertCustomer(b: WriteBatch, c: CustomerRec): void {
  b.add(
    `INSERT INTO customers (id, name, phone, cnic, address, credit_limit, notes, is_active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      c.id,
      c.name,
      c.phone,
      c.cnic,
      c.address,
      c.creditLimit,
      c.notes,
      c.isActive ? 1 : 0,
      c.createdAt,
      c.updatedAt,
    ],
  ).emit('customer', c.id, 'insert', c);
}
export function updateCustomer(b: WriteBatch, c: CustomerRec): void {
  b.add(
    'UPDATE customers SET name = ?, phone = ?, address = ?, credit_limit = ?, notes = ?, updated_at = ? WHERE id = ?',
    [c.name, c.phone, c.address, c.creditLimit, c.notes, c.updatedAt, c.id],
  ).emit('customer', c.id, 'update', c);
}
export async function loadCustomerRec(driver: SqlDriver, id: string): Promise<CustomerRec> {
  const rows = await driver.query<Raw>('SELECT * FROM customers WHERE id = ?', [id]);
  const row = rows[0];
  if (row === undefined) throw new ServiceError('NOT_FOUND', 'Customer not found', { id });
  return mapRow<CustomerRec>(row);
}

export interface SupplierRec {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}
export function insertSupplier(b: WriteBatch, s: SupplierRec): void {
  b.add(
    'INSERT INTO suppliers (id, name, phone, address, notes, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [s.id, s.name, s.phone, s.address, s.notes, s.isActive ? 1 : 0, s.createdAt, s.updatedAt],
  ).emit('supplier', s.id, 'insert', s);
}
export async function requireSupplier(driver: SqlDriver, id: string): Promise<SupplierRec> {
  const rows = await driver.query<Raw>('SELECT * FROM suppliers WHERE id = ?', [id]);
  const row = rows[0];
  if (row === undefined) throw new ServiceError('NOT_FOUND', 'Supplier not found', { id });
  return mapRow<SupplierRec>(row);
}

export interface UserRec {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}
/**
 * The outbox payload is the public User shape only: the PIN hash never crosses the contract (people.ts). Giving a
 * second device the same login is a Phase 2b server concern (provision the user there), not something to sync.
 */
export function insertUser(b: WriteBatch, u: UserRec, pinHash: string): void {
  b.add(
    `INSERT INTO users (id, username, display_name, role, pin_hash, is_active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      u.id,
      u.username,
      u.displayName,
      u.role,
      pinHash,
      u.isActive ? 1 : 0,
      u.createdAt,
      u.updatedAt,
    ],
  ).emit('user', u.id, 'insert', u);
}
export function updateUserPin(b: WriteBatch, u: UserRec, pinHash: string, at: number): void {
  b.add('UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?', [pinHash, at, u.id]).emit(
    'user',
    u.id,
    'update',
    { ...u, updatedAt: at },
  );
}

export interface MovementRec {
  id: string;
  branchId: string;
  type: StockMovementType;
  itemId: string;
  /** Module batch_expiry: the batch this movement belongs to; absent or null = stock without a batch. */
  batchId?: string | null;
  quantity: number;
  unitCost: number | null;
  refType: StockRefType | null;
  refId: string | null;
  reason: string | null;
  createdBy: string;
  createdAt: number;
}
export function insertMovement(b: WriteBatch, m: MovementRec): void {
  b.add(
    `INSERT INTO stock_movements (id, branch_id, type, item_id, batch_id, quantity, unit_cost,
       ref_type, ref_id, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      m.id,
      m.branchId,
      m.type,
      m.itemId,
      m.batchId ?? null,
      m.quantity,
      m.unitCost,
      m.refType,
      m.refId,
      m.reason,
      m.createdBy,
      m.createdAt,
    ],
  ).emit('stock_movement', m.id, 'insert', m);
}

export interface LedgerRec {
  id: string;
  customerId: string | null;
  supplierId: string | null;
  type: LedgerEntryType;
  amount: number;
  method: Exclude<PaymentMethod, 'khata'> | null;
  saleId: string | null;
  purchaseId: string | null;
  note: string | null;
  createdBy: string;
  createdAt: number;
}
export function insertLedger(b: WriteBatch, e: LedgerRec): void {
  b.add(
    `INSERT INTO ledger_entries (id, customer_id, supplier_id, type, amount, method, sale_id, purchase_id, note,
       created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      e.id,
      e.customerId,
      e.supplierId,
      e.type,
      e.amount,
      e.method,
      e.saleId,
      e.purchaseId,
      e.note,
      e.createdBy,
      e.createdAt,
    ],
  ).emit('ledger_entry', e.id, 'insert', e);
}

export interface PurchaseRec {
  id: string;
  supplierId: string;
  branchId: string;
  kind: 'purchase' | 'return';
  referenceNo: string | null;
  total: number;
  note: string | null;
  createdBy: string;
  createdAt: number;
}
export function insertPurchase(b: WriteBatch, p: PurchaseRec): void {
  b.add(
    `INSERT INTO purchases (id, supplier_id, branch_id, kind, reference_no, total, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      p.id,
      p.supplierId,
      p.branchId,
      p.kind,
      p.referenceNo,
      p.total,
      p.note,
      p.createdBy,
      p.createdAt,
    ],
  ).emit('purchase', p.id, 'insert', p);
}

/** sales + sale_lines + payments + the 'sale' outbox row (payload = the full Invoice). */
export function insertInvoice(b: WriteBatch, s: Invoice): void {
  b.add(
    `INSERT INTO sales (id, device_id, seq, invoice_no, kind, original_sale_id, branch_id, customer_id, cashier_id,
       subtotal, discount_total, total, note, created_at, hash_version, prev_hash, hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      s.id,
      s.deviceId,
      s.seq,
      s.invoiceNo,
      s.kind,
      s.originalSaleId,
      s.branchId,
      s.customerId,
      s.cashierId,
      s.subtotal,
      s.discountTotal,
      s.total,
      s.note,
      s.createdAt,
      s.hashVersion,
      s.prevHash,
      s.hash,
    ],
  );
  for (const l of s.lines)
    b.add(
      `INSERT INTO sale_lines (id, sale_id, line_no, product_id, item_id, description, quantity,
         unit_price, cost_price, discount_amount, line_total, unit_scale, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        l.id,
        l.saleId,
        l.lineNo,
        l.productId,
        l.itemId,
        l.description,
        l.quantity,
        l.unitPrice,
        l.costPrice,
        l.discountAmount,
        l.lineTotal,
        l.unitScale,
        l.createdAt,
      ],
    );
  for (const p of s.payments)
    b.add(
      'INSERT INTO payments (id, sale_id, method, amount, reference, created_at) VALUES (?,?,?,?,?,?)',
      [p.id, p.saleId, p.method, p.amount, p.reference, p.createdAt],
    );
  b.emit('sale', s.id, 'insert', s);
}

export type Params = readonly SqlValue[];
