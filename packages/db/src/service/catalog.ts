import {
  PHONE_CONDITIONS,
  PTA_STATUSES,
  type CatalogHit,
  type Id,
  type NewAccessoryInput,
  type NewPhoneUnitInput,
  type PosService,
  type ProductKind,
  type ProductRef,
} from '@pos/shared';
import type { SqlValue, Statement } from '../driver';
import {
  emit,
  insert,
  loadMeta,
  one,
  phoneView,
  phoneViews,
  requirePerm,
  variantView,
  variantViews,
  write,
  type Ctx,
} from './context';
import { fail, intIn, invalid, isValidImei, money, optIntIn, optText, text } from './errors';

const SEARCH_LIMIT = 20;

/** Escapes LIKE wildcards; used with ESCAPE '\'. */
const likeTerm = (s: string): string => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

// ---------------- product lookup ----------------

/** Existing product by id, or find-or-create by (kind, brand, name) case-insensitively. */
export async function resolveProduct(
  ctx: Ctx,
  ref: ProductRef,
  kind: ProductKind,
  t: number,
): Promise<{ id: Id; statements: Statement[] }> {
  if ('productId' in ref) {
    const p = await one<{ id: string; kind: string }>(
      ctx,
      'SELECT id, kind FROM products WHERE id = ?',
      [ref.productId],
    );
    if (!p || p.kind !== kind) return fail('NOT_FOUND', 'Product not found', { field: 'product' });
    return { id: p.id, statements: [] };
  }
  const brand = optText(ref.brand, 'product.brand', 60) ?? '';
  const name = text(ref.name, 'product.name', 120);
  const hit = await one<{ id: string }>(
    ctx,
    'SELECT id FROM products WHERE kind = ? AND lower(brand) = lower(?) AND lower(name) = lower(?) LIMIT 1',
    [kind, brand, name],
  );
  if (hit) return { id: hit.id, statements: [] };
  const id = ctx.newId();
  const row = {
    id,
    kind,
    brand,
    name,
    category: optText(ref.category, 'product.category', 60),
    is_active: 1,
    created_at: t,
    updated_at: t,
  };
  return { id, statements: [insert('products', row), emit(ctx, 'product', id, row, t)] };
}

// ---------------- phone units ----------------

interface ValidPhone {
  imei1: string | null;
  imei2: string | null;
  serial: string | null;
  row: Record<string, SqlValue>;
}

async function validatePhone(ctx: Ctx, i: NewPhoneUnitInput): Promise<ValidPhone> {
  const imei1 = optText(i.imei1, 'imei1', 15);
  const imei2 = optText(i.imei2, 'imei2', 15);
  const serial = optText(i.serial, 'serial', 60);
  if (imei1 === null && serial === null) invalid('imei1', 'Provide IMEI or serial');
  for (const [field, v] of [
    ['imei1', imei1],
    ['imei2', imei2],
  ] as const)
    if (v !== null && !isValidImei(v)) invalid(field, `${field} is not a valid IMEI`);
  if (imei1 !== null && imei1 === imei2) invalid('imei2', 'imei2 must differ from imei1');
  for (const [field, v] of [
    ['imei1', imei1],
    ['imei2', imei2],
  ] as const) {
    if (v === null) continue;
    const dup = await one(ctx, 'SELECT 1 AS x FROM phone_units WHERE imei1 = ? OR imei2 = ?', [
      v,
      v,
    ]);
    if (dup) fail('DUPLICATE', `${field} already exists`, { field });
  }
  if (
    serial !== null &&
    (await one(ctx, 'SELECT 1 AS x FROM phone_units WHERE serial = ?', [serial]))
  )
    fail('DUPLICATE', 'serial already exists', { field: 'serial' });
  if (!(PTA_STATUSES as readonly string[]).includes(i.ptaStatus))
    invalid('ptaStatus', 'Unknown PTA status');
  if (!(PHONE_CONDITIONS as readonly string[]).includes(i.condition))
    invalid('condition', 'Unknown condition');

  return {
    imei1,
    imei2,
    serial,
    row: {
      imei1,
      imei2,
      serial,
      colour: optText(i.colour, 'colour', 40),
      storage_gb: optIntIn(i.storageGb, 'storageGb', 1, 4096),
      ram_gb: optIntIn(i.ramGb, 'ramGb', 1, 64),
      battery_health_pct: optIntIn(i.batteryHealthPct, 'batteryHealthPct', 0, 100),
      pta_status: i.ptaStatus,
      condition: i.condition,
      cost_price: money(i.costPrice, 'costPrice'),
      sale_price: money(i.salePrice, 'salePrice'),
      supplier_id: i.supplierId ?? null,
      note: optText(i.note, 'note', 400),
    },
  };
}

/** Statements that create one phone unit and (optionally) put it in stock with the given movement type. */
export async function phoneUnitStatements(
  ctx: Ctx,
  i: NewPhoneUnitInput,
  opts: {
    branchId: Id;
    userId: Id;
    t: number;
    movement: 'opening' | 'purchase' | null;
    refId?: Id;
  },
): Promise<{ id: Id; statements: Statement[] }> {
  const v = await validatePhone(ctx, i);
  const product = await resolveProduct(ctx, i.product, 'phone', opts.t);
  const id = ctx.newId();
  const row = { id, product_id: product.id, ...v.row, created_at: opts.t, updated_at: opts.t };
  const statements: Statement[] = [
    ...product.statements,
    insert('phone_units', row),
    emit(ctx, 'phone_unit', id, row, opts.t),
  ];
  if (opts.movement)
    statements.push(
      ...movement(ctx, {
        branchId: opts.branchId,
        type: opts.movement,
        phoneUnitId: id,
        variantId: null,
        quantity: 1,
        unitCost: Number(v.row.cost_price),
        refType: opts.refId ? 'purchase' : null,
        refId: opts.refId ?? null,
        reason: null,
        userId: opts.userId,
        t: opts.t,
      }),
    );
  return { id, statements };
}

export function movement(
  ctx: Ctx,
  m: {
    branchId: Id;
    type: string;
    phoneUnitId: Id | null;
    variantId: Id | null;
    quantity: number;
    unitCost: number | null;
    refType: string | null;
    refId: Id | null;
    reason: string | null;
    userId: Id;
    t: number;
  },
): Statement[] {
  const id = ctx.newId();
  const row = {
    id,
    branch_id: m.branchId,
    type: m.type,
    phone_unit_id: m.phoneUnitId,
    variant_id: m.variantId,
    quantity: m.quantity,
    unit_cost: m.unitCost,
    ref_type: m.refType,
    ref_id: m.refId,
    reason: m.reason,
    created_by: m.userId,
    created_at: m.t,
  };
  return [insert('stock_movements', row), emit(ctx, 'stock_movement', id, row, m.t)];
}

// ---------------- accessories ----------------

async function accessoryStatements(
  ctx: Ctx,
  i: NewAccessoryInput,
  opts: { branchId: Id; userId: Id; t: number },
): Promise<{ id: Id; statements: Statement[] }> {
  const sku = text(i.sku, 'sku', 40);
  const barcode = optText(i.barcode, 'barcode', 40);
  if (await one(ctx, 'SELECT 1 AS x FROM accessory_variants WHERE sku = ?', [sku]))
    fail('DUPLICATE', 'SKU already exists', { field: 'sku' });
  if (
    barcode &&
    (await one(ctx, 'SELECT 1 AS x FROM accessory_variants WHERE barcode = ?', [barcode]))
  )
    fail('DUPLICATE', 'Barcode already exists', { field: 'barcode' });
  const openingQty = optIntIn(i.openingQty, 'openingQty', 0, 1_000_000) ?? 0;
  const product = await resolveProduct(ctx, i.product, 'accessory', opts.t);
  const id = ctx.newId();
  const row = {
    id,
    product_id: product.id,
    sku,
    barcode,
    model: optText(i.model, 'model', 60),
    colour: optText(i.colour, 'colour', 40),
    cost_price: money(i.costPrice, 'costPrice'),
    sale_price: money(i.salePrice, 'salePrice'),
    reorder_level: optIntIn(i.reorderLevel, 'reorderLevel', 0, 100_000) ?? 5,
    is_active: 1,
    created_at: opts.t,
    updated_at: opts.t,
  };
  const statements = [
    ...product.statements,
    insert('accessory_variants', row),
    emit(ctx, 'accessory_variant', id, row, opts.t),
  ];
  if (openingQty > 0)
    statements.push(
      ...movement(ctx, {
        branchId: opts.branchId,
        type: 'opening',
        phoneUnitId: null,
        variantId: id,
        quantity: openingQty,
        unitCost: row.cost_price,
        refType: null,
        refId: null,
        reason: null,
        userId: opts.userId,
        t: opts.t,
      }),
    );
  return { id, statements };
}

/** UPDATE built from a camelCase patch; only whitelisted columns. */
function updateStatement(
  ctx: Ctx,
  table: string,
  entity: string,
  id: Id,
  cols: Record<string, SqlValue>,
  t: number,
): Statement[] {
  const keys = Object.keys(cols);
  if (keys.length === 0) return [];
  return [
    {
      sql: `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      params: [...keys.map((k) => cols[k] ?? null), t, id],
    },
    emit(ctx, entity, id, { id, ...cols, updated_at: t }, t, 'update'),
  ];
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function catalogApi(ctx: Ctx): PosService['catalog'] {
  return {
    async search(query, o = {}) {
      requirePerm(ctx, 'sell');
      const qy = query.trim();
      if (!qy) return [];
      const { branchId } = await loadMeta(ctx);
      const limit = o.limit ?? SEARCH_LIMIT;
      const hits: CatalogHit[] = [];

      // 1. exact scanner matches (IMEI / serial / barcode / SKU)
      for (const v of await phoneViews(
        ctx,
        'WHERE pu.imei1 = ? OR pu.imei2 = ? OR lower(pu.serial) = lower(?)',
        [qy, qy, qy],
      )) {
        if (o.inStockOnly && !v.inStock) continue;
        const matchedBy = v.unit.imei1 === qy || v.unit.imei2 === qy ? 'imei' : 'serial';
        hits.push({ kind: 'phone_unit', matchedBy, item: v });
      }
      for (const v of await variantViews(
        ctx,
        branchId,
        'WHERE av.is_active = 1 AND (av.barcode = ? OR lower(av.sku) = lower(?))',
        [qy, qy],
      )) {
        if (o.inStockOnly && v.onHand <= 0) continue;
        hits.push({
          kind: 'variant',
          matchedBy: v.variant.barcode === qy ? 'barcode' : 'sku',
          item: v,
        });
      }
      if (hits.length > 0) return hits.slice(0, limit);

      // 2. every word must appear somewhere in the name / model / colour / codes
      const terms = qy.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      const phoneHay =
        "lower(p.brand || ' ' || p.name || ' ' || COALESCE(pu.colour,'') || ' ' || COALESCE(pu.imei1,'') || ' ' || COALESCE(pu.storage_gb,''))";
      const phones = await phoneViews(
        ctx,
        `WHERE ${terms.map(() => `${phoneHay} LIKE ? ESCAPE '\\'`).join(' AND ')} ORDER BY p.brand, p.name LIMIT ?`,
        [...terms.map(likeTerm), limit * 3],
      );
      for (const v of phones) {
        if (o.inStockOnly && !v.inStock) continue;
        hits.push({ kind: 'phone_unit', matchedBy: 'name', item: v });
      }
      const varHay =
        "lower(p.brand || ' ' || p.name || ' ' || COALESCE(av.model,'') || ' ' || COALESCE(av.colour,'') || ' ' || av.sku || ' ' || COALESCE(av.barcode,''))";
      const variants = await variantViews(
        ctx,
        branchId,
        `WHERE av.is_active = 1 AND ${terms.map(() => `${varHay} LIKE ? ESCAPE '\\'`).join(' AND ')} ORDER BY p.name LIMIT ?`,
        [...terms.map(likeTerm), limit * 3],
      );
      for (const v of variants) {
        if (o.inStockOnly && v.onHand <= 0) continue;
        hits.push({ kind: 'variant', matchedBy: 'name', item: v });
      }
      return hits.slice(0, limit);
    },

    async listPhones(f = {}) {
      requirePerm(ctx, 'view_catalog');
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (f.pta) {
        where.push('pu.pta_status = ?');
        params.push(f.pta);
      }
      if (f.condition) {
        where.push('pu.condition = ?');
        params.push(f.condition);
      }
      const qy = f.q?.trim().toLowerCase();
      if (qy) {
        where.push(
          "lower(p.brand || ' ' || p.name || ' ' || COALESCE(pu.imei1,'') || ' ' || COALESCE(pu.imei2,'') || ' ' || COALESCE(pu.serial,'') || ' ' || COALESCE(pu.colour,'')) LIKE ? ESCAPE '\\'",
        );
        params.push(likeTerm(qy));
      }
      const views = await phoneViews(
        ctx,
        `${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pu.created_at DESC`,
        params,
      );
      return f.inStock === undefined ? views : views.filter((v) => v.inStock === f.inStock);
    },

    async listAccessories(f = {}) {
      requirePerm(ctx, 'view_catalog');
      const { branchId } = await loadMeta(ctx);
      const qy = f.q?.trim().toLowerCase();
      const views = await variantViews(
        ctx,
        branchId,
        qy
          ? "WHERE lower(p.brand || ' ' || p.name || ' ' || COALESCE(av.model,'') || ' ' || COALESCE(av.colour,'') || ' ' || av.sku || ' ' || COALESCE(av.barcode,'')) LIKE ? ESCAPE '\\' ORDER BY p.name, av.model"
          : 'ORDER BY p.name, av.model',
        qy ? [likeTerm(qy)] : [],
      );
      return f.lowStockOnly ? views.filter((v) => v.lowStock && v.variant.isActive) : views;
    },

    createPhoneUnit: (i) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'edit_catalog');
        const { branchId } = await loadMeta(ctx);
        const t = ctx.now();
        const r = await phoneUnitStatements(ctx, i, {
          branchId,
          userId: s.user.id,
          t,
          movement: i.openingStock === false ? null : 'opening',
        });
        await write(ctx, r.statements);
        return phoneView(ctx, r.id);
      }),

    createAccessory: (i) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'edit_catalog');
        const { branchId } = await loadMeta(ctx);
        const r = await accessoryStatements(ctx, i, { branchId, userId: s.user.id, t: ctx.now() });
        await write(ctx, r.statements);
        return variantView(ctx, branchId, r.id);
      }),

    updatePhoneUnit: (id, patch) =>
      ctx.lock(async () => {
        requirePerm(ctx, 'edit_catalog');
        await phoneView(ctx, id);
        const cols: Record<string, SqlValue> = {};
        if (has(patch, 'colour')) cols.colour = optText(patch.colour, 'colour', 40);
        if (has(patch, 'storageGb'))
          cols.storage_gb = optIntIn(patch.storageGb, 'storageGb', 1, 4096);
        if (has(patch, 'ramGb')) cols.ram_gb = optIntIn(patch.ramGb, 'ramGb', 1, 64);
        if (has(patch, 'batteryHealthPct'))
          cols.battery_health_pct = optIntIn(patch.batteryHealthPct, 'batteryHealthPct', 0, 100);
        if (patch.ptaStatus !== undefined) {
          if (!(PTA_STATUSES as readonly string[]).includes(patch.ptaStatus))
            invalid('ptaStatus', 'Unknown PTA status');
          cols.pta_status = patch.ptaStatus;
        }
        if (patch.condition !== undefined) {
          if (!(PHONE_CONDITIONS as readonly string[]).includes(patch.condition))
            invalid('condition', 'Unknown condition');
          cols.condition = patch.condition;
        }
        if (patch.costPrice !== undefined) cols.cost_price = money(patch.costPrice, 'costPrice');
        if (patch.salePrice !== undefined) cols.sale_price = money(patch.salePrice, 'salePrice');
        if (has(patch, 'note')) cols.note = optText(patch.note, 'note', 400);
        if (has(patch, 'serial')) cols.serial = optText(patch.serial, 'serial', 60);
        if (has(patch, 'imei2')) {
          const v = optText(patch.imei2, 'imei2', 15);
          if (v !== null && !isValidImei(v)) invalid('imei2', 'imei2 is not a valid IMEI');
          cols.imei2 = v;
        }
        await write(ctx, updateStatement(ctx, 'phone_units', 'phone_unit', id, cols, ctx.now()));
        return phoneView(ctx, id);
      }),

    updateVariant: (id, patch) =>
      ctx.lock(async () => {
        requirePerm(ctx, 'edit_catalog');
        const { branchId } = await loadMeta(ctx);
        await variantView(ctx, branchId, id);
        const cols: Record<string, SqlValue> = {};
        if (has(patch, 'barcode')) cols.barcode = optText(patch.barcode, 'barcode', 40);
        if (has(patch, 'model')) cols.model = optText(patch.model, 'model', 60);
        if (has(patch, 'colour')) cols.colour = optText(patch.colour, 'colour', 40);
        if (patch.costPrice !== undefined) cols.cost_price = money(patch.costPrice, 'costPrice');
        if (patch.salePrice !== undefined) cols.sale_price = money(patch.salePrice, 'salePrice');
        if (patch.reorderLevel !== undefined)
          cols.reorder_level = intIn(patch.reorderLevel, 'reorderLevel', 0, 100_000);
        if (patch.isActive !== undefined) cols.is_active = patch.isActive ? 1 : 0;
        await write(
          ctx,
          updateStatement(ctx, 'accessory_variants', 'accessory_variant', id, cols, ctx.now()),
        );
        return variantView(ctx, branchId, id);
      }),

    adjustStock: ({ variantId, delta, reason }) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'adjust_stock');
        const meta = await loadMeta(ctx);
        const d = intIn(delta, 'delta', -1_000_000, 1_000_000);
        const why = optText(reason, 'reason', 200);
        if (d === 0 || why === null) invalid('delta', 'Reason and a non-zero change are required');
        const current = await variantView(ctx, meta.branchId, variantId);
        if (!meta.allowNegativeStock && current.onHand + d < 0)
          fail('STOCK_INSUFFICIENT', 'Stock cannot go below zero', {
            onHand: current.onHand,
            requested: -d,
          });
        await write(
          ctx,
          movement(ctx, {
            branchId: meta.branchId,
            type: 'adjustment',
            phoneUnitId: null,
            variantId,
            quantity: d,
            unitCost: current.variant.costPrice,
            refType: null,
            refId: null,
            reason: why,
            userId: s.user.id,
            t: ctx.now(),
          }),
        );
        return variantView(ctx, meta.branchId, variantId);
      }),
  };
}

export { accessoryStatements };
