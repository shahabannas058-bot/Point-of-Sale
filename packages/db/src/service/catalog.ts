import {
  MAX_QUANTITY_ANY,
  PhoneConditionSchema,
  PtaStatusSchema,
  ServiceError,
  UnitLabelSchema,
  maxQuantity,
  pktDate,
  unitScaleFor,
  type CatalogApi,
  type CatalogHit,
  type NewAccessoryInput,
  type NewPhoneUnitInput,
  type PhoneUnitView,
  type ProductRef,
  type VariantView,
} from '@pos/shared';
import { WriteBatch } from './batch';
import { takeOutParts } from './batches';
import { requirePermission, requireSession, type Ctx } from './deps';
import { guardApi, intIn, invalid, money, optIntIn, optText, reqText } from './errors';
import { queryItemHistory } from './item-history';
import { loadQuickItems, saveQuickItems } from './quick-items';
import type { Raw } from './mappers';
import { toPhoneView, toVariantView } from './mappers';
import { loadShop } from './meta';
import { assertModule } from './modules';
import {
  PHONE_VIEW_SQL,
  VARIANT_VIEW_SQL,
  insertMovement,
  insertPhoneUnit,
  insertProduct,
  insertVariant,
  likePattern,
  loadPhoneUnitRec,
  loadVariantRec,
  requirePhoneView,
  requireVariantView,
  updatePhoneUnit,
  updateVariant,
  variantOnHand,
  type PhoneUnitRec,
  type ProductRec,
  type VariantRec,
} from './queries';
import type { SqlDriver, SqlValue } from '../types';

// ---------- IMEI (Luhn) ----------
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
export const isValidImei = (s: string): boolean => /^\d{15}$/.test(s) && luhnValid(s);
/** Check digit that makes `body14 + digit` a valid IMEI. */
export function imeiCheckDigit(body14: string): string {
  for (let d = 0; d <= 9; d += 1) if (luhnValid(`${body14}${d}`)) return String(d);
  return '0';
}

// ---------- phone input normalisation ----------
export interface PhoneFields {
  imei1: string | null;
  imei2: string | null;
  serial: string | null;
  colour: string | null;
  storageGb: number | null;
  ramGb: number | null;
  batteryHealthPct: number | null;
  ptaStatus: PhoneUnitRec['ptaStatus'];
  condition: PhoneUnitRec['condition'];
  costPrice: number;
  salePrice: number;
  supplierId: string | null;
  note: string | null;
}

export function normalizePhone(i: NewPhoneUnitInput): PhoneFields {
  const imei1 = optText(i.imei1, 'imei1', 15);
  const imei2 = optText(i.imei2, 'imei2', 15);
  const serial = optText(i.serial, 'serial', 64);
  if (imei1 !== null && !isValidImei(imei1))
    throw invalid('imei1', 'IMEI 1 must be 15 digits and pass the Luhn check');
  if (imei2 !== null && !isValidImei(imei2))
    throw invalid('imei2', 'IMEI 2 must be 15 digits and pass the Luhn check');
  if (imei1 === null && serial === null)
    throw invalid('imei1', 'Provide an IMEI or a serial number');
  if (imei2 !== null && imei1 === null) throw invalid('imei2', 'IMEI 2 requires IMEI 1');
  if (imei1 !== null && imei1 === imei2) throw invalid('imei2', 'IMEI 2 must differ from IMEI 1');
  const pta = PtaStatusSchema.safeParse(i.ptaStatus);
  if (!pta.success) throw invalid('ptaStatus', 'Unknown PTA status');
  const cond = PhoneConditionSchema.safeParse(i.condition);
  if (!cond.success) throw invalid('condition', 'Unknown phone condition');
  return {
    imei1,
    imei2,
    serial,
    colour: optText(i.colour, 'colour', 40),
    storageGb: optIntIn(i.storageGb, 'storageGb', 1, 100_000),
    ramGb: optIntIn(i.ramGb, 'ramGb', 1, 100_000),
    batteryHealthPct: optIntIn(i.batteryHealthPct, 'batteryHealthPct', 0, 100),
    ptaStatus: pta.data,
    condition: cond.data,
    costPrice: money(i.costPrice, 'costPrice'),
    salePrice: money(i.salePrice, 'salePrice'),
    supplierId: i.supplierId ?? null,
    note: optText(i.note, 'note', 500),
  };
}

/** imei1 / imei2 / serial must not already exist anywhere (an imei2 may equal another phone's imei1 in no case). */
async function assertIdentifiersFree(
  driver: SqlDriver,
  f: PhoneFields,
  seen: Set<string>,
): Promise<void> {
  const checks: ['imei1' | 'imei2' | 'serial', string | null][] = [
    ['imei1', f.imei1],
    ['imei2', f.imei2],
    ['serial', f.serial],
  ];
  for (const [field, value] of checks) {
    if (value === null) continue;
    const key = `${field === 'serial' ? 's' : 'i'}:${value}`;
    if (seen.has(key)) throw new ServiceError('DUPLICATE', `Duplicate ${field}`, { field, value });
    seen.add(key);
    const rows =
      field === 'serial'
        ? await driver.query<{ n: number }>(
            'SELECT COUNT(*) AS n FROM phone_units WHERE serial = ?',
            [value],
          )
        : await driver.query<{ n: number }>(
            'SELECT COUNT(*) AS n FROM phone_units WHERE imei1 = ? OR imei2 = ?',
            [value, value],
          );
    if ((rows[0]?.n ?? 0) > 0)
      throw new ServiceError('DUPLICATE', `A phone with this ${field} already exists`, {
        field,
        value,
      });
  }
}

// ---------- product find-or-create (batch-scoped) ----------
export type ProductResolver = (ref: ProductRef, kind: 'phone' | 'accessory') => Promise<string>;

export function createProductResolver(ctx: Ctx, b: WriteBatch, at: number): ProductResolver {
  const created = new Map<string, string>();
  return async (ref, kind) => {
    if ('productId' in ref) {
      const rows = await ctx.driver.query<{ kind: string }>(
        'SELECT kind FROM products WHERE id = ?',
        [ref.productId],
      );
      if (rows[0] === undefined)
        throw new ServiceError('NOT_FOUND', 'Product not found', { id: ref.productId });
      if (rows[0].kind !== kind) throw invalid('product', `Product is not an ${kind} product`);
      return ref.productId;
    }
    const brand = reqText(ref.brand, 'brand', 1, 60);
    const name = reqText(ref.name, 'name', 1, 120);
    const category = optText(ref.category, 'category', 60);
    const key = `${kind}|${brand.toLowerCase()}|${name.toLowerCase()}`;
    const cached = created.get(key);
    if (cached !== undefined) return cached;
    const rows = await ctx.driver.query<{ id: string }>(
      'SELECT id FROM products WHERE kind = ? AND lower(brand) = lower(?) AND lower(name) = lower(?) LIMIT 1',
      [kind, brand, name],
    );
    if (rows[0] !== undefined) return rows[0].id;
    const rec: ProductRec = {
      id: ctx.newId(),
      kind,
      brand,
      name,
      category,
      isActive: true,
      createdAt: at,
      updatedAt: at,
    };
    insertProduct(b, rec);
    created.set(key, rec.id);
    return rec.id;
  };
}

export interface StagePhoneOpts {
  at: number;
  branchId: string;
  actorId: string;
  resolveProduct: ProductResolver;
  /** Fallback supplier when the input has none. */
  defaultSupplierId: string | null;
  /** 'none' = unit is created but not put into stock. */
  stock: { type: 'adjustment' } | { type: 'purchase'; purchaseId: string } | { type: 'none' };
  /** Identifiers staged earlier in the same batch (detects duplicates inside one purchase). */
  seen: Set<string>;
}

/** Adds the product (if new), the phone unit, and its +1 movement to the batch. Call inside the write lock. */
export async function stagePhoneUnit(
  ctx: Ctx,
  b: WriteBatch,
  input: NewPhoneUnitInput,
  opts: StagePhoneOpts,
): Promise<PhoneUnitRec> {
  const f = normalizePhone(input);
  await assertIdentifiersFree(ctx.driver, f, opts.seen);
  const productId = await opts.resolveProduct(input.product, 'phone');
  const rec: PhoneUnitRec = {
    id: ctx.newId(),
    productId,
    ...f,
    supplierId: f.supplierId ?? opts.defaultSupplierId,
    createdAt: opts.at,
    updatedAt: opts.at,
  };
  insertPhoneUnit(b, rec);
  if (opts.stock.type !== 'none') {
    const purchase = opts.stock.type === 'purchase';
    insertMovement(b, {
      id: ctx.newId(),
      branchId: opts.branchId,
      type: purchase ? 'purchase' : 'adjustment',
      phoneUnitId: rec.id,
      variantId: null,
      quantity: 1,
      unitCost: rec.costPrice,
      refType: purchase ? 'purchase' : null,
      refId: opts.stock.type === 'purchase' ? opts.stock.purchaseId : null,
      reason: purchase ? null : 'Opening stock',
      createdBy: opts.actorId,
      createdAt: opts.at,
    });
  }
  return rec;
}

// ---------- search ----------
const PHONE_TEXT =
  "(p.brand || ' ' || p.name || ' ' || COALESCE(pu.colour, '') || ' ' || COALESCE(pu.serial, '') || ' ' || COALESCE(pu.imei1, '') || ' ' || COALESCE(pu.imei2, ''))";
const VARIANT_TEXT =
  "(p.brand || ' ' || p.name || ' ' || COALESCE(av.model, '') || ' ' || COALESCE(av.colour, '') || ' ' || av.sku || ' ' || COALESCE(av.barcode, ''))";

const tokenClauses = (text: string, q: string): { sql: string; params: SqlValue[] } => {
  const tokens = q.split(/\s+/).filter((t) => t !== '');
  return {
    sql: tokens.map(() => `${text} LIKE ? ESCAPE '\\'`).join(' AND '),
    params: tokens.map(likePattern),
  };
};

export function createCatalogApi(ctx: Ctx): CatalogApi {
  const branch = async (): Promise<string> => (await loadShop(ctx.driver)).branchId;

  const phones = async (
    where: string,
    params: SqlValue[],
    order = true,
  ): Promise<PhoneUnitView[]> => {
    const rows = await ctx.driver.query<Raw>(
      `${PHONE_VIEW_SQL} ${where}${order ? ' ORDER BY p.brand, p.name, pu.created_at, pu.id' : ''}`,
      params,
    );
    return rows.map(toPhoneView);
  };
  const variants = async (
    branchId: string,
    where: string,
    params: SqlValue[],
  ): Promise<VariantView[]> => {
    const rows = await ctx.driver.query<Raw>(
      `${VARIANT_VIEW_SQL} ${where} ORDER BY p.brand, p.name, av.model, av.colour, av.sku`,
      [branchId, ...params],
    );
    return rows.map(toVariantView);
  };

  return guardApi<CatalogApi>({
    async search(query, opts = {}) {
      requireSession(ctx);
      const q = (typeof query === 'string' ? query : '').trim();
      if (q === '') return [];
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
      const stock = opts.inStockOnly === true;
      const branchId = await branch();
      const hits: CatalogHit[] = [];
      const seen = new Set<string>();
      const push = (hit: CatalogHit): void => {
        const id = hit.kind === 'phone_unit' ? hit.item.unit.id : hit.item.variant.id;
        if (seen.has(id) || hits.length >= limit) return;
        seen.add(id);
        hits.push(hit);
      };
      const phoneStock = stock ? ' AND on_hand > 0' : '';
      const variantStock = stock ? ' AND on_hand > 0' : '';

      // 1. exact scanner hits
      for (const v of await variants(
        branchId,
        `WHERE av.is_active = 1 AND (av.barcode = ? OR av.sku = ?)${variantStock}`,
        [q, q],
      ))
        push({ kind: 'variant', matchedBy: v.variant.barcode === q ? 'barcode' : 'sku', item: v });
      for (const p of await phones(
        `WHERE (pu.imei1 = ? OR pu.imei2 = ? OR pu.serial = ?)${phoneStock}`,
        [q, q, q],
      ))
        push({
          kind: 'phone_unit',
          matchedBy: p.unit.serial === q ? 'serial' : 'imei',
          item: p,
        });

      // 2. text search on names (every word must match)
      const pt = tokenClauses(PHONE_TEXT, q);
      for (const p of await phones(`WHERE ${pt.sql}${phoneStock}`, pt.params))
        push({ kind: 'phone_unit', matchedBy: /^\d+$/.test(q) ? 'imei' : 'name', item: p });
      const vt = tokenClauses(VARIANT_TEXT, q);
      for (const v of await variants(
        branchId,
        `WHERE av.is_active = 1 AND ${vt.sql}${variantStock}`,
        vt.params,
      ))
        push({ kind: 'variant', matchedBy: 'name', item: v });
      return hits;
    },

    async listPhones(f = {}) {
      requireSession(ctx);
      const conds: string[] = ['p.is_active = 1'];
      const params: SqlValue[] = [];
      if (f.q !== undefined && f.q.trim() !== '') {
        const t = tokenClauses(PHONE_TEXT, f.q.trim());
        conds.push(t.sql);
        params.push(...t.params);
      }
      if (f.inStock === true) conds.push('on_hand > 0');
      if (f.inStock === false) conds.push('on_hand = 0');
      if (f.pta !== undefined) {
        conds.push('pu.pta_status = ?');
        params.push(f.pta);
      }
      if (f.condition !== undefined) {
        conds.push('pu.condition = ?');
        params.push(f.condition);
      }
      return phones(`WHERE ${conds.join(' AND ')}`, params);
    },

    async listAccessories(f = {}) {
      requireSession(ctx);
      const conds: string[] = ['av.is_active = 1'];
      const params: SqlValue[] = [];
      if (f.q !== undefined && f.q.trim() !== '') {
        const t = tokenClauses(VARIANT_TEXT, f.q.trim());
        conds.push(t.sql);
        params.push(...t.params);
      }
      if (f.lowStockOnly === true) conds.push('on_hand <= av.reorder_level');
      return variants(await branch(), `WHERE ${conds.join(' AND ')}`, params);
    },

    async itemHistory(ref, q = {}) {
      // Read-level, like the stock listings: every role has view_catalog; no module gate (core ledger).
      requirePermission(ctx, 'view_catalog');
      return queryItemHistory(ctx, ref, q);
    },

    async createPhoneUnit(i) {
      const session = requirePermission(ctx, 'edit_catalog');
      const shop = await loadShop(ctx.driver);
      assertModule(shop.modules, 'imei');
      normalizePhone(i); // fail fast before taking the lock
      const unitId = await ctx.lock(async () => {
        const at = ctx.clock();
        const b = new WriteBatch(ctx.newId, at);
        const opening = i.openingStock !== false;
        const rec = await stagePhoneUnit(ctx, b, i, {
          at,
          branchId: shop.branchId,
          actorId: session.user.id,
          resolveProduct: createProductResolver(ctx, b, at),
          defaultSupplierId: null,
          stock: opening ? { type: 'adjustment' } : { type: 'none' },
          seen: new Set(),
        });
        if (opening)
          await ctx.assertCanSell({ action: 'stock_entry', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
        return rec.id;
      });
      return requirePhoneView(ctx.driver, unitId);
    },

    async createAccessory(i: NewAccessoryInput) {
      const session = requirePermission(ctx, 'edit_catalog');
      const shop = await loadShop(ctx.driver);
      const sku = reqText(i.sku, 'sku', 1, 64);
      const barcode = optText(i.barcode, 'barcode', 64);
      const model = optText(i.model, 'model', 80);
      const colour = optText(i.colour, 'colour', 40);
      const costPrice = money(i.costPrice, 'costPrice');
      const salePrice = money(i.salePrice, 'salePrice');
      const unit = UnitLabelSchema.safeParse(i.unit ?? 'pcs');
      if (!unit.success) throw invalid('unit', 'Unknown unit');
      if (unit.data !== 'pcs') assertModule(shop.modules, 'weight_units');
      const unitScale = unitScaleFor(unit.data);
      const reorderLevel =
        i.reorderLevel === undefined
          ? 0
          : intIn(i.reorderLevel, 'reorderLevel', 0, maxQuantity(unitScale));
      const openingQty =
        i.openingQty === undefined
          ? 0
          : intIn(i.openingQty, 'openingQty', 0, maxQuantity(unitScale));
      const variantId = await ctx.lock(async () => {
        const at = ctx.clock();
        const b = new WriteBatch(ctx.newId, at);
        const productId = await createProductResolver(ctx, b, at)(i.product, 'accessory');
        const rec: VariantRec = {
          id: ctx.newId(),
          productId,
          sku,
          barcode,
          model,
          colour,
          costPrice,
          salePrice,
          reorderLevel,
          unitScale,
          unitLabel: unit.data,
          isActive: true,
          createdAt: at,
          updatedAt: at,
        };
        insertVariant(b, rec);
        if (openingQty > 0) {
          insertMovement(b, {
            id: ctx.newId(),
            branchId: shop.branchId,
            type: 'adjustment',
            phoneUnitId: null,
            variantId: rec.id,
            quantity: openingQty,
            unitCost: costPrice,
            refType: null,
            refId: null,
            reason: 'Opening stock',
            createdBy: session.user.id,
            createdAt: at,
          });
          await ctx.assertCanSell({ action: 'stock_entry', branchId: shop.branchId, now: at });
        }
        await b.commit(ctx.driver);
        return rec.id;
      });
      return requireVariantView(ctx.driver, variantId, shop.branchId);
    },

    async updatePhoneUnit(id, p) {
      requirePermission(ctx, 'edit_catalog');
      await ctx.lock(async () => {
        const cur = await loadPhoneUnitRec(ctx.driver, id);
        const at = ctx.clock();
        const next: PhoneUnitRec = { ...cur, updatedAt: at };
        if (p.salePrice !== undefined) next.salePrice = money(p.salePrice, 'salePrice');
        if (p.costPrice !== undefined) next.costPrice = money(p.costPrice, 'costPrice');
        if (p.colour !== undefined) next.colour = optText(p.colour, 'colour', 40);
        if (p.note !== undefined) next.note = optText(p.note, 'note', 500);
        if (p.batteryHealthPct !== undefined)
          next.batteryHealthPct = optIntIn(p.batteryHealthPct, 'batteryHealthPct', 0, 100);
        if (p.ptaStatus !== undefined) {
          const r = PtaStatusSchema.safeParse(p.ptaStatus);
          if (!r.success) throw invalid('ptaStatus', 'Unknown PTA status');
          next.ptaStatus = r.data;
        }
        if (p.condition !== undefined) {
          const r = PhoneConditionSchema.safeParse(p.condition);
          if (!r.success) throw invalid('condition', 'Unknown phone condition');
          next.condition = r.data;
        }
        const b = new WriteBatch(ctx.newId, at);
        updatePhoneUnit(b, next);
        await b.commit(ctx.driver);
      });
      return requirePhoneView(ctx.driver, id);
    },

    async updateVariant(id, p) {
      requirePermission(ctx, 'edit_catalog');
      const branchId = await branch();
      await ctx.lock(async () => {
        const cur = await loadVariantRec(ctx.driver, id);
        const at = ctx.clock();
        const next: VariantRec = { ...cur, updatedAt: at };
        if (p.salePrice !== undefined) next.salePrice = money(p.salePrice, 'salePrice');
        if (p.costPrice !== undefined) next.costPrice = money(p.costPrice, 'costPrice');
        if (p.barcode !== undefined) next.barcode = optText(p.barcode, 'barcode', 64);
        if (p.reorderLevel !== undefined)
          next.reorderLevel = intIn(p.reorderLevel, 'reorderLevel', 0, maxQuantity(cur.unitScale));
        if (p.model !== undefined) next.model = optText(p.model, 'model', 80);
        if (p.colour !== undefined) next.colour = optText(p.colour, 'colour', 40);
        const b = new WriteBatch(ctx.newId, at);
        updateVariant(b, next);
        await b.commit(ctx.driver);
      });
      return requireVariantView(ctx.driver, id, branchId);
    },

    async adjustStock(i) {
      const session = requirePermission(ctx, 'adjust_stock');
      const shop = await loadShop(ctx.driver);
      const delta = intIn(i.delta, 'delta', -MAX_QUANTITY_ANY, MAX_QUANTITY_ANY);
      if (delta === 0) throw invalid('delta', 'Adjustment cannot be zero');
      const reason = reqText(i.reason, 'reason', 1, 300);
      await ctx.lock(async () => {
        const variant = await loadVariantRec(ctx.driver, i.variantId); // NOT_FOUND
        if (Math.abs(delta) > maxQuantity(variant.unitScale))
          throw invalid('delta', 'Adjustment is larger than this item allows');
        if (delta < 0 && !shop.settings.allowNegativeStock) {
          const onHand = await variantOnHand(ctx.driver, i.variantId, shop.branchId);
          if (onHand + delta < 0)
            throw new ServiceError('STOCK_INSUFFICIENT', 'Not enough stock for this adjustment', {
              onHand,
              requested: -delta,
            });
        }
        const at = ctx.clock();
        // Module batch_expiry: stock removed from a batch-tracked item leaves its batches first-expiry-first
        // (expired ones included: that is how expired goods are thrown away), one movement per batch, so the
        // batches' stock keeps adding up to the item's. Stock added here has no expiry date: it is stock without a
        // batch, sold after the batches. Stock with a known expiry date is received through purchasing.receive.
        const parts =
          delta > 0
            ? [{ batchId: null, quantity: delta }]
            : await takeOutParts(ctx.driver, shop, i.variantId, -delta, pktDate(at), {
                includeExpired: true,
              });
        const b = new WriteBatch(ctx.newId, at);
        for (const p of parts)
          insertMovement(b, {
            id: ctx.newId(),
            branchId: shop.branchId,
            type: 'adjustment',
            phoneUnitId: null,
            variantId: i.variantId,
            batchId: p.batchId,
            quantity: delta > 0 ? p.quantity : -p.quantity,
            unitCost: null,
            refType: null,
            refId: null,
            reason,
            createdBy: session.user.id,
            createdAt: at,
          });
        await ctx.assertCanSell({ action: 'stock_entry', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
      });
      return requireVariantView(ctx.driver, i.variantId, shop.branchId);
    },

    async quickItems() {
      requireSession(ctx);
      return loadQuickItems(ctx, await branch());
    },

    async setQuickItems(variantIds) {
      requirePermission(ctx, 'manage_settings');
      const branchId = await branch();
      await saveQuickItems(ctx, variantIds);
      return loadQuickItems(ctx, branchId);
    },
  });
}
