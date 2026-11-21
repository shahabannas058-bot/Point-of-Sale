import {
  MAX_QUANTITY_ANY,
  ServiceError,
  UnitLabelSchema,
  maxQuantity,
  pktDate,
  unitScaleFor,
  type CatalogApi,
  type CatalogHit,
  type NewAccessoryInput,
  type ProductKind,
  type ProductRef,
  type VariantView,
} from '@pos/shared';
import { WriteBatch } from './batch';
import { takeOutParts } from './batches';
import { requirePermission, requireSession, type Ctx } from './deps';
import { guardApi, intIn, invalid, money, optText, reqText } from './errors';
import { queryItemHistory } from './item-history';
import { loadQuickItems, saveQuickItems } from './quick-items';
import type { Raw } from './mappers';
import { toVariantView } from './mappers';
import { loadShop } from './meta';
import { assertModule } from './modules';
import {
  VARIANT_VIEW_SQL,
  insertMovement,
  insertProduct,
  insertVariant,
  likePattern,
  loadVariantRec,
  requireVariantView,
  updateVariant,
  variantOnHand,
  type ProductRec,
  type VariantRec,
} from './queries';
import type { SqlValue } from '../types';

// ---------- product find-or-create (batch-scoped) ----------
/** Every item's product row carries this legacy products.kind value. */
const ITEM_KIND: ProductKind = 'accessory';

type ProductResolver = (ref: ProductRef) => Promise<string>;

function createProductResolver(ctx: Ctx, b: WriteBatch, at: number): ProductResolver {
  const created = new Map<string, string>();
  return async (ref) => {
    if ('productId' in ref) {
      const rows = await ctx.driver.query<{ kind: string }>(
        'SELECT kind FROM products WHERE id = ?',
        [ref.productId],
      );
      if (rows[0] === undefined)
        throw new ServiceError('NOT_FOUND', 'Product not found', { id: ref.productId });
      if (rows[0].kind !== ITEM_KIND) throw invalid('product', 'Product is not an item product');
      return ref.productId;
    }
    const brand = reqText(ref.brand, 'brand', 1, 60);
    const name = reqText(ref.name, 'name', 1, 120);
    const category = optText(ref.category, 'category', 60);
    const key = `${brand.toLowerCase()}|${name.toLowerCase()}`;
    const cached = created.get(key);
    if (cached !== undefined) return cached;
    const rows = await ctx.driver.query<{ id: string }>(
      'SELECT id FROM products WHERE kind = ? AND lower(brand) = lower(?) AND lower(name) = lower(?) LIMIT 1',
      [ITEM_KIND, brand, name],
    );
    if (rows[0] !== undefined) return rows[0].id;
    const rec: ProductRec = {
      id: ctx.newId(),
      kind: ITEM_KIND,
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

// ---------- search ----------
const VARIANT_TEXT =
  "(p.brand || ' ' || p.name || ' ' || COALESCE(av.model, '') || ' ' || COALESCE(av.colour, '') || ' ' || av.sku || ' ' || COALESCE(av.barcode, ''))";

const tokenClauses = (text: string, q: string): { sql: string; params: SqlValue[] } => {
  const tokens = q.split(/\s+/).filter((t) => t !== '');
  return {
    sql: tokens.map(() => `${text} LIKE ? ESCAPE '\\'`).join(' AND '),
    params: tokens.map(likePattern),
  };
};

/** 0 = the label starts with the typed text, 1 = every typed word starts some word of it, 2 = it is only somewhere inside. */
type TextRank = 0 | 1 | 2;
const textRank = (label: string, q: string): TextRank => {
  const typed = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const text = label.toLowerCase();
  if (text.startsWith(typed.join(' '))) return 0;
  const words = text.split(/[^\p{L}\p{N}]+/u);
  return typed.every((w) => words.some((x) => x.startsWith(w))) ? 1 : 2;
};

export function createCatalogApi(ctx: Ctx): CatalogApi {
  const branch = async (): Promise<string> => (await loadShop(ctx.driver)).branchId;

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
        const id = hit.item.variant.id;
        if (seen.has(id) || hits.length >= limit) return;
        seen.add(id);
        hits.push(hit);
      };
      const variantStock = stock ? ' AND on_hand > 0' : '';

      // 1. exact scanner hits
      for (const v of await variants(
        branchId,
        `WHERE av.is_active = 1 AND (av.barcode = ? OR av.sku = ?)${variantStock}`,
        [q, q],
      ))
        push({ kind: 'variant', matchedBy: v.variant.barcode === q ? 'barcode' : 'sku', item: v });

      // 2. text search on names (every word must match); names that start with the text come first
      const vt = tokenClauses(VARIANT_TEXT, q);
      const text: { rank: TextRank; hit: CatalogHit }[] = [];
      for (const v of await variants(
        branchId,
        `WHERE av.is_active = 1 AND ${vt.sql}${variantStock}`,
        vt.params,
      ))
        text.push({
          rank: textRank(v.label, q),
          hit: { kind: 'variant', matchedBy: 'name', item: v },
        });
      // Array.sort is stable: inside one rank the brand / name order from SQL is kept
      text.sort((a, b) => a.rank - b.rank);
      for (const { rank, hit } of text) if (rank < 2 || opts.prefixOnly !== true) push(hit);
      return hits;
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
        const productId = await createProductResolver(ctx, b, at)(i.product);
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
