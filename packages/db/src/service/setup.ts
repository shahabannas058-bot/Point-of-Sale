import {
  BusinessTypeSchema,
  MODULE_PRESETS,
  ServiceError,
  formatModuleList,
  type SetupApi,
  type ShopInfo,
} from '@pos/shared';
import { WriteBatch } from './batch';
import type { Ctx } from './deps';
import { guardApi, invalid, reqText } from './errors';
import { DEFAULT_CASHIER_MAX_DISCOUNT_BPS, META, isSetUp, loadShop, upsertMeta } from './meta';
import { hashPin, validatePinFormat } from './pin';
import { insertUser, type UserRec } from './queries';

export async function readShopInfo(ctx: Ctx): Promise<ShopInfo> {
  const shop = await loadShop(ctx.driver);
  const rows = await ctx.driver.query<{ name: string }>('SELECT name FROM branches WHERE id = ?', [
    shop.branchId,
  ]);
  return {
    deviceId: shop.deviceId,
    branchId: shop.branchId,
    branchName: rows[0]?.name ?? '',
    shopName: shop.settings.shopName,
    invoicePrefix: shop.invoicePrefix,
    createdAt: shop.setupAt,
    isDemo: shop.isDemo,
    businessType: shop.businessType,
    modules: shop.modules,
  };
}

export function createSetupApi(ctx: Ctx): SetupApi {
  return guardApi<SetupApi>({
    isSetUp: () => isSetUp(ctx.driver),

    async firstRun(input) {
      if (await isSetUp(ctx.driver))
        throw new ServiceError('ALREADY_SETUP', 'Shop is already set up');
      const shopName = reqText(input.shopName, 'shopName', 1, 100);
      const branchName = reqText(input.branchName, 'branchName', 1, 100);
      const prefix = typeof input.invoicePrefix === 'string' ? input.invoicePrefix.trim() : '';
      if (!/^[A-Z0-9]{1,4}$/.test(prefix))
        throw invalid('invoicePrefix', 'Invoice prefix must be 1-4 capital letters or digits');
      const username = reqText(input.owner.username, 'owner.username', 3, 32).toLowerCase();
      if (!/^[a-z0-9._-]+$/.test(username))
        throw invalid(
          'owner.username',
          'Username may contain only a-z, 0-9, dot, dash, underscore',
        );
      const type = BusinessTypeSchema.safeParse(input.businessType ?? 'custom');
      if (!type.success) throw invalid('businessType', 'Unknown business type');
      const displayName = reqText(input.owner.displayName, 'owner.displayName', 1, 100);
      validatePinFormat(input.owner.pin, 'owner.pin');
      const pinHash = await hashPin(input.owner.pin, ctx.pinIterations, ctx.randomBytes);

      await ctx.lock(async () => {
        if (await isSetUp(ctx.driver))
          throw new ServiceError('ALREADY_SETUP', 'Shop is already set up');
        const at = ctx.clock();
        const deviceId = ctx.newId();
        const branchId = ctx.newId();
        const owner: UserRec = {
          id: ctx.newId(),
          username,
          displayName,
          role: 'owner',
          isActive: true,
          createdAt: at,
          updatedAt: at,
        };
        const b = new WriteBatch(ctx.newId, at);
        for (const s of [
          upsertMeta(META.deviceId, deviceId),
          upsertMeta(META.invoicePrefix, prefix),
          upsertMeta(META.branchId, branchId),
          upsertMeta(META.shopName, shopName),
          upsertMeta(META.cashierMaxDiscountBps, String(DEFAULT_CASHIER_MAX_DISCOUNT_BPS)),
          upsertMeta(META.allowNegativeStock, '0'),
          upsertMeta(META.setupAt, String(at)),
          upsertMeta(META.businessType, type.data),
          upsertMeta(META.modules, formatModuleList(MODULE_PRESETS[type.data])),
        ])
          b.add(s.sql, s.params);
        b.add('INSERT INTO branches (id, name, created_at) VALUES (?,?,?)', [
          branchId,
          branchName,
          at,
        ]);
        b.emit('branch', branchId, 'insert', { id: branchId, name: branchName, createdAt: at });
        insertUser(b, owner, pinHash);
        await b.commit(ctx.driver);
      });
      return readShopInfo(ctx);
    },

    getShop: () => readShopInfo(ctx),
  });
}
