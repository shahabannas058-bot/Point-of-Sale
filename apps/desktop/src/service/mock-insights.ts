/* In-memory twin of the insights section for the mock PosService (?mock=1).
   Same contract as packages/db/src/service/insights.ts and the same maths (@pos/core reorderFigures /
   compareReorder). The mock keeps no stock ledger: receiving stock overwrites the item cost, so the item's
   cost price is its latest purchase cost. */
import { compareReorder, paisa, reorderFigures } from '@pos/core';
import {
  ServiceError,
  type AccessoryVariant,
  type Invoice,
  type ItemInsight,
  type Permission,
  type PhoneUnit,
  type PhoneUnitView,
  type PosService,
  type ReorderSuggestion,
  type SaleLine,
  type VariantView,
} from '@pos/shared';

const DAY_MS = 86_400_000;
const INSIGHT_DAYS = 30;
const LEAD_DAYS = 7;

export interface InsightDeps {
  now: () => number;
  require: (p: Permission) => void;
  can: (p: Permission) => boolean;
  variants: readonly AccessoryVariant[];
  variantView: (v: AccessoryVariant) => VariantView;
  units: readonly PhoneUnit[];
  unitView: (u: PhoneUnit) => PhoneUnitView;
  invoices: readonly Invoice[];
  customerExists: (id: string) => boolean;
  customerBalance: (id: string) => number;
}

const fail = (code: 'VALIDATION' | 'NOT_FOUND', message: string, field: string): never => {
  throw new ServiceError(code, message, { field });
};

const run = <T>(fn: () => T): Promise<T> => {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
};

const optId = (v: unknown, field: string): string | null => {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && v.trim() !== '' ? v : fail('VALIDATION', 'Must be an id', field);
};

const optInt = (v: unknown, field: string, min: number, max: number, dflt: number): number => {
  if (v === undefined || v === null) return dflt;
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
    ? v
    : fail('VALIDATION', `Must be a whole number from ${min} to ${max}`, field);
};

export function createMockInsights(d: InsightDeps): PosService['insights'] {
  /** Net quantity (returns are negative lines) of matching lines sold since `since`. */
  const soldSince = (since: number, match: (l: SaleLine) => boolean): number =>
    d.invoices
      .filter((inv) => inv.createdAt >= since)
      .flatMap((inv) => inv.lines)
      .filter(match)
      .reduce((n, l) => n + l.quantity, 0);

  return {
    item: (input) =>
      run((): ItemInsight => {
        d.require('sell');
        const variantId = optId(input.variantId, 'variantId');
        const phoneUnitId = optId(input.phoneUnitId, 'phoneUnitId');
        const customerId = optId(input.customerId, 'customerId');
        if ((variantId === null) === (phoneUnitId === null))
          fail('VALIDATION', 'Give exactly one of variantId or phoneUnitId', 'variantId');

        let onHand: number;
        let match: (l: SaleLine) => boolean;
        let lastPurchase: ItemInsight['lastPurchase'] = null;
        if (variantId) {
          const v =
            d.variants.find((x) => x.id === variantId) ??
            fail('NOT_FOUND', 'Accessory not found', 'variantId');
          onHand = d.variantView(v).onHand;
          match = (l) => l.variantId === variantId;
          if (d.can('view_cost')) lastPurchase = { unitCost: v.costPrice, at: v.updatedAt };
        } else {
          const u =
            d.units.find((x) => x.id === phoneUnitId) ??
            fail('NOT_FOUND', 'Phone unit not found', 'phoneUnitId');
          onHand = d.unitView(u).inStock ? 1 : 0;
          match = (l) => l.productId === u.productId && l.phoneUnitId !== null;
          if (d.can('view_cost')) lastPurchase = { unitCost: u.costPrice, at: u.createdAt };
        }

        let lastSoldToCustomer: ItemInsight['lastSoldToCustomer'] = null;
        let customerBalance: ItemInsight['customerBalance'] = null;
        if (customerId) {
          if (!d.customerExists(customerId)) fail('NOT_FOUND', 'Customer not found', 'customerId');
          // invoices are appended in order, so the last match is the latest sale
          const hit = d.invoices
            .filter((inv) => inv.kind === 'sale' && inv.customerId === customerId)
            .flatMap((inv) => inv.lines.filter(match).map((l) => ({ inv, l })))
            .at(-1);
          lastSoldToCustomer = hit
            ? {
                unitPrice: paisa(Math.round(hit.l.lineTotal / hit.l.quantity)),
                at: hit.inv.createdAt,
                invoiceNo: hit.inv.invoiceNo,
              }
            : null;
          customerBalance = paisa(d.customerBalance(customerId));
        }

        return {
          onHand,
          lastPurchase,
          lastSoldToCustomer,
          customerBalance,
          soldLast30Days: Math.max(0, soldSince(d.now() - INSIGHT_DAYS * DAY_MS, match)),
        };
      }),

    reorder: (options = {}) =>
      run((): ReorderSuggestion[] => {
        d.require('view_catalog');
        const days = optInt(options.days, 'days', 1, 365, 30);
        const coverDays = optInt(options.coverDays, 'coverDays', 1, 180, 14);
        const since = d.now() - days * DAY_MS;
        const showCost = d.can('view_cost');
        const rows: ReorderSuggestion[] = [];
        for (const v of d.variants) {
          if (!v.isActive) continue;
          const item = d.variantView(v);
          const sold = Math.max(
            0,
            soldSince(since, (l) => l.variantId === v.id),
          );
          const f = reorderFigures({
            onHand: item.onHand,
            reorderLevel: v.reorderLevel,
            sold,
            days,
            coverDays,
            leadDays: LEAD_DAYS,
          });
          if (!f.needsReorder) continue;
          rows.push({
            item,
            sold,
            dailyAvg: f.dailyAvg,
            daysLeft: f.daysLeft,
            suggestedQty: f.suggestedQty,
            unitCost: showCost ? v.costPrice : null,
          });
        }
        const rank = (r: ReorderSuggestion) => ({
          daysLeft: r.daysLeft,
          onHand: r.item.onHand,
          reorderLevel: r.item.variant.reorderLevel,
          label: r.item.label,
        });
        return rows.sort((a, b) => compareReorder(rank(a), rank(b)));
      }),
  };
}
