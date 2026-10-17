import { createUuidV7Generator } from '@pos/core';
import {
  hasPermission,
  type AccessoryVariant,
  type ApprovalReason,
  type Customer,
  type Id,
  type Paisa,
  type Permission,
  type PhoneUnit,
  type PhoneUnitView,
  type Product,
  type Session,
  type Supplier,
  type VariantView,
} from '@pos/shared';
import type { SqlDriver, SqlValue, Statement } from '../driver';
import { fail, mapError } from './errors';

/** Called inside the write path right before a sale/return is written. Throw LICENCE_BLOCKED to block. */
export type LicenceHook = (action: 'sale' | 'return' | 'void', branchId: Id, nowMs: number) => void;

export interface ServiceOptions {
  driver: SqlDriver;
  now?: () => number;
  newId?: () => Id;
  licence?: LicenceHook;
  /** Approval tokens live this long (ms). */
  approvalTtlMs?: number;
}

type Row = Record<string, SqlValue>;

export interface Ctx {
  db: SqlDriver;
  now: () => number;
  newId: () => Id;
  licence: LicenceHook;
  approvalTtlMs: number;
  session: Session | null;
  grants: Map<string, { username: string; expiresAt: number }>;
  loginFails: Map<string, { n: number; until: number }>;
  /** Serialises every write so the invoice chain and stock checks see a stable head. */
  lock: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function createCtx(o: ServiceOptions): Ctx {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    db: o.driver,
    now: o.now ?? Date.now,
    newId: o.newId ?? createUuidV7Generator(),
    licence: o.licence ?? (() => undefined),
    approvalTtlMs: o.approvalTtlMs ?? 60_000,
    session: null,
    grants: new Map(),
    loginFails: new Map(),
    lock<T>(fn: () => Promise<T>): Promise<T> {
      const run = chain.then(fn, fn);
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

// ---------------- db helpers ----------------

export async function q<T extends object = Row>(
  ctx: Ctx,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<T[]> {
  try {
    return await ctx.db.query<T>(sql, params);
  } catch (e) {
    throw mapError(e);
  }
}

export async function one<T extends object = Row>(
  ctx: Ctx,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<T | undefined> {
  return (await q<T>(ctx, sql, params))[0];
}

export async function scalar(
  ctx: Ctx,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<number> {
  const r = await one<{ n: number | null }>(ctx, sql, params);
  return Number(r?.n ?? 0);
}

export async function write(ctx: Ctx, statements: readonly Statement[]): Promise<void> {
  try {
    await ctx.db.batch(statements);
  } catch (e) {
    throw mapError(e);
  }
}

/** Outbox row for the sync engine. */
export const emit = (
  ctx: Ctx,
  entityType: string,
  entityId: Id,
  payload: unknown,
  at: number,
  op: 'insert' | 'update' = 'insert',
): Statement => ({
  sql: 'INSERT INTO outbox (id, entity_type, entity_id, op, payload, created_at) VALUES (?,?,?,?,?,?)',
  params: [ctx.newId(), entityType, entityId, op, JSON.stringify(payload), at],
});

/** INSERT for a plain object of column -> value. */
export function insert(table: string, row: Record<string, SqlValue>): Statement {
  const cols = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    params: cols.map((c) => row[c] ?? null),
  };
}

export const bool = (b: boolean): number => (b ? 1 : 0);

// ---------------- auth helpers ----------------

export const can = (ctx: Ctx, p: Permission): boolean =>
  ctx.session !== null && hasPermission(ctx.session.user.role, p);

export function requireSession(ctx: Ctx): Session {
  return ctx.session ?? fail('NOT_AUTHENTICATED', 'Sign in first');
}

export function requirePerm(ctx: Ctx, p: Permission): Session {
  const s = requireSession(ctx);
  if (!hasPermission(s.user.role, p))
    fail('FORBIDDEN', `Permission required: ${p}`, { permission: p });
  return s;
}

/** Single-use manager approval. Missing token -> APPROVAL_REQUIRED; bad/expired -> APPROVAL_INVALID. */
export function takeApproval(ctx: Ctx, token: string | undefined, reason: ApprovalReason): string {
  if (!token) return fail('APPROVAL_REQUIRED', 'Manager approval is required', { reason });
  const g = ctx.grants.get(token);
  if (!g || g.expiresAt < ctx.now()) return fail('APPROVAL_INVALID', 'Approval expired or invalid');
  return g.username;
}

export const consumeApproval = (ctx: Ctx, token: string | undefined): void => {
  if (token) ctx.grants.delete(token);
};

// ---------------- shop meta ----------------

export interface Meta {
  deviceId: Id;
  branchId: Id;
  prefix: string;
  maxDiscountBps: number;
  allowNegativeStock: boolean;
  raw: Record<string, string>;
}

export async function readMeta(ctx: Ctx): Promise<Record<string, string>> {
  const rows = await q<{ key: string; value: string }>(ctx, 'SELECT key, value FROM app_meta');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function loadMeta(ctx: Ctx): Promise<Meta> {
  const raw = await readMeta(ctx);
  const deviceId = raw.device_id;
  const branchId = raw.branch_id;
  const prefix = raw.invoice_prefix;
  if (!deviceId || !branchId || !prefix) return fail('NOT_SETUP', 'Shop has not been set up yet');
  const bps = Number.parseInt(raw.cashier_max_discount_bps ?? '', 10);
  return {
    deviceId,
    branchId,
    prefix,
    maxDiscountBps: Number.isSafeInteger(bps) ? bps : 500,
    allowNegativeStock: raw.allow_negative_stock === '1',
    raw,
  };
}

// ---------------- row mappers ----------------

const str = (v: SqlValue | undefined): string | null =>
  v === null || v === undefined ? null : String(v);
const num = (v: SqlValue | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);
const p = (v: SqlValue | undefined): Paisa => Number(v ?? 0) as Paisa;

export const toProduct = (r: Row): Product => ({
  id: String(r.id),
  kind: String(r.kind) as Product['kind'],
  brand: String(r.brand),
  name: String(r.name),
  category: str(r.category),
  isActive: Number(r.is_active) === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export const toPhoneUnit = (r: Row): PhoneUnit => ({
  id: String(r.id),
  productId: String(r.product_id),
  imei1: str(r.imei1),
  imei2: str(r.imei2),
  serial: str(r.serial),
  colour: str(r.colour),
  storageGb: num(r.storage_gb),
  ramGb: num(r.ram_gb),
  batteryHealthPct: num(r.battery_health_pct),
  ptaStatus: String(r.pta_status) as PhoneUnit['ptaStatus'],
  condition: String(r.condition) as PhoneUnit['condition'],
  costPrice: p(r.cost_price),
  salePrice: p(r.sale_price),
  supplierId: str(r.supplier_id),
  note: str(r.note),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export const toVariant = (r: Row): AccessoryVariant => ({
  id: String(r.id),
  productId: String(r.product_id),
  sku: String(r.sku),
  barcode: str(r.barcode),
  model: str(r.model),
  colour: str(r.colour),
  costPrice: p(r.cost_price),
  salePrice: p(r.sale_price),
  reorderLevel: Number(r.reorder_level),
  isActive: Number(r.is_active) === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export const toCustomer = (r: Row): Customer => ({
  id: String(r.id),
  name: String(r.name),
  phone: str(r.phone),
  cnic: str(r.cnic),
  address: str(r.address),
  creditLimit: r.credit_limit === null || r.credit_limit === undefined ? null : p(r.credit_limit),
  notes: str(r.notes),
  isActive: Number(r.is_active) === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export const toSupplier = (r: Row): Supplier => ({
  id: String(r.id),
  name: String(r.name),
  phone: str(r.phone),
  address: str(r.address),
  notes: str(r.notes),
  isActive: Number(r.is_active) === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const joinNonEmpty = (sep: string, parts: (string | null | undefined)[]): string =>
  parts.filter((x): x is string => typeof x === 'string' && x !== '').join(sep);

/** "Samsung Galaxy A55 (Blue, 8/256GB)" — same as PhoneLabel in SalesService.cs. */
export function phoneLabel(
  brand: string,
  name: string,
  colour: string | null,
  ramGb: number | null,
  storageGb: number | null,
): string {
  const mem =
    ramGb !== null && storageGb !== null
      ? `${String(ramGb)}/${String(storageGb)}GB`
      : storageGb !== null
        ? `${String(storageGb)}GB`
        : null;
  const extra = joinNonEmpty(', ', [colour, mem]);
  return joinNonEmpty(' ', [`${brand} ${name}`, extra === '' ? null : `(${extra})`]);
}

/** "Generic Tempered Glass (Galaxy A55, Clear)" — same as VariantLabel in SalesService.cs. */
export function variantLabel(
  brand: string,
  name: string,
  model: string | null,
  colour: string | null,
): string {
  const extra = joinNonEmpty(', ', [model, colour]);
  return joinNonEmpty(' ', [`${brand} ${name}`, extra === '' ? null : `(${extra})`]);
}

// ---------------- views ----------------

const PHONE_SELECT = `
  SELECT pu.*,
         p.id AS p_id, p.kind AS p_kind, p.brand AS p_brand, p.name AS p_name, p.category AS p_category,
         p.is_active AS p_is_active, p.created_at AS p_created_at, p.updated_at AS p_updated_at,
         COALESCE((SELECT SUM(sm.quantity) FROM stock_movements sm WHERE sm.phone_unit_id = pu.id), 0) AS on_hand
  FROM phone_units pu JOIN products p ON p.id = pu.product_id`;

const VARIANT_SELECT = (branchParam: string): string => `
  SELECT av.*,
         p.id AS p_id, p.kind AS p_kind, p.brand AS p_brand, p.name AS p_name, p.category AS p_category,
         p.is_active AS p_is_active, p.created_at AS p_created_at, p.updated_at AS p_updated_at,
         COALESCE((SELECT SUM(sm.quantity) FROM stock_movements sm
                   WHERE sm.variant_id = av.id AND sm.branch_id = ${branchParam}), 0) AS on_hand
  FROM accessory_variants av JOIN products p ON p.id = av.product_id`;

const productFromPrefixed = (r: Row): Product =>
  toProduct({
    id: r.p_id ?? null,
    kind: r.p_kind ?? null,
    brand: r.p_brand ?? null,
    name: r.p_name ?? null,
    category: r.p_category ?? null,
    is_active: r.p_is_active ?? null,
    created_at: r.p_created_at ?? null,
    updated_at: r.p_updated_at ?? null,
  });

export function toPhoneView(r: Row): PhoneUnitView {
  const unit = toPhoneUnit(r);
  const product = productFromPrefixed(r);
  return {
    unit,
    product,
    inStock: Number(r.on_hand) === 1,
    label: phoneLabel(product.brand, product.name, unit.colour, unit.ramGb, unit.storageGb),
  };
}

export function toVariantView(r: Row): VariantView {
  const variant = toVariant(r);
  const product = productFromPrefixed(r);
  const onHand = Number(r.on_hand);
  return {
    variant,
    product,
    onHand,
    lowStock: onHand <= variant.reorderLevel,
    label: variantLabel(product.brand, product.name, variant.model, variant.colour),
  };
}

export async function phoneViews(
  ctx: Ctx,
  where = '',
  params: readonly SqlValue[] = [],
): Promise<PhoneUnitView[]> {
  const rows = await q(ctx, `${PHONE_SELECT} ${where}`, params);
  return rows.map(toPhoneView);
}

export async function variantViews(
  ctx: Ctx,
  branchId: Id,
  where = '',
  params: readonly SqlValue[] = [],
): Promise<VariantView[]> {
  const rows = await q(ctx, `${VARIANT_SELECT('?')} ${where}`, [branchId, ...params]);
  return rows.map(toVariantView);
}

export async function phoneView(ctx: Ctx, id: Id): Promise<PhoneUnitView> {
  const [v] = await phoneViews(ctx, 'WHERE pu.id = ?', [id]);
  return v ?? fail('NOT_FOUND', 'Phone unit not found', { id });
}

export async function variantView(ctx: Ctx, branchId: Id, id: Id): Promise<VariantView> {
  const [v] = await variantViews(ctx, branchId, 'WHERE av.id = ?', [id]);
  return v ?? fail('NOT_FOUND', 'Accessory not found', { id });
}
