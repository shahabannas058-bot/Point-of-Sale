import type { SettingsApi, ShopSettings } from '@pos/shared';
import { WriteBatch } from './batch';
import { requirePermission, requireSession, type Ctx } from './deps';
import { guardApi, intIn, invalid, optText, reqText } from './errors';
import { META, deleteMeta, loadShop, upsertMeta } from './meta';

export function createSettingsApi(ctx: Ctx): SettingsApi {
  const get = async (): Promise<ShopSettings> => (await loadShop(ctx.driver)).settings;

  return guardApi<SettingsApi>({
    async get() {
      requireSession(ctx);
      return get();
    },

    async update(patch) {
      requirePermission(ctx, 'manage_settings');
      await loadShop(ctx.driver); // NOT_SETUP guard
      await ctx.lock(async () => {
        const b = new WriteBatch(ctx.newId, ctx.clock());
        const text = (key: string, value: string | null): void => {
          const s = value === null ? deleteMeta(key) : upsertMeta(key, value);
          b.add(s.sql, s.params);
        };
        if (patch.shopName !== undefined)
          text(META.shopName, reqText(patch.shopName, 'shopName', 1, 100));
        if (patch.address !== undefined)
          text(META.shopAddress, optText(patch.address, 'address', 300));
        if (patch.phone !== undefined) text(META.shopPhone, optText(patch.phone, 'phone', 40));
        if (patch.receiptFooter !== undefined)
          text(META.receiptFooter, optText(patch.receiptFooter, 'receiptFooter', 300));
        if (patch.receiptFooterUr !== undefined)
          text(META.receiptFooterUr, optText(patch.receiptFooterUr, 'receiptFooterUr', 300));
        if (patch.cashierMaxDiscountBps !== undefined)
          text(
            META.cashierMaxDiscountBps,
            String(intIn(patch.cashierMaxDiscountBps, 'cashierMaxDiscountBps', 0, 10_000)),
          );
        if (patch.allowNegativeStock !== undefined) {
          if (typeof patch.allowNegativeStock !== 'boolean')
            throw invalid('allowNegativeStock', 'allowNegativeStock must be true or false');
          text(META.allowNegativeStock, patch.allowNegativeStock ? '1' : '0');
        }
        if (b.size > 0) await b.commit(ctx.driver);
      });
      return get();
    },
  });
}
