import {
  BusinessTypeSchema,
  MODULE_IDS,
  ServiceError,
  parseModuleList,
  type BusinessType,
  type ModuleId,
  type ShopSettings,
} from '@pos/shared';
import type { SqlDriver, Statement } from '../types';

/** app_meta keys owned by the service. `tenant_id` and `sync_cursor` belong to the sync slice. */
export const META = {
  deviceId: 'device_id',
  invoicePrefix: 'invoice_prefix',
  branchId: 'branch_id',
  shopName: 'shop_name',
  shopAddress: 'shop_address',
  shopPhone: 'shop_phone',
  receiptFooter: 'receipt_footer',
  receiptFooterUr: 'receipt_footer_ur',
  cashierMaxDiscountBps: 'cashier_max_discount_bps',
  allowNegativeStock: 'allow_negative_stock',
  demoData: 'demo_data',
  setupAt: 'setup_at',
  /** BusinessType. Missing on shops created before modules existed: they keep every module. */
  businessType: 'business_type',
  /** Comma-separated ModuleId list. Later written by the licence token (ADR-0003). */
  modules: 'modules',
} as const;

export const DEFAULT_CASHIER_MAX_DISCOUNT_BPS = 500;

export interface ShopMeta {
  deviceId: string;
  branchId: string;
  invoicePrefix: string;
  setupAt: number;
  isDemo: boolean;
  businessType: BusinessType;
  modules: ModuleId[];
  settings: ShopSettings;
}

export async function readMetaMap(driver: SqlDriver): Promise<Map<string, string>> {
  const rows = await driver.query<{ key: string; value: string }>(
    'SELECT key, value FROM app_meta',
  );
  return new Map(rows.map((r) => [r.key, r.value]));
}

export async function isSetUp(driver: SqlDriver): Promise<boolean> {
  const rows = await driver.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM app_meta WHERE key = ?',
    [META.deviceId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** Reads fresh from the database every time (never cached) so a second service instance stays coherent. */
export async function loadShop(driver: SqlDriver): Promise<ShopMeta> {
  const m = await readMetaMap(driver);
  const deviceId = m.get(META.deviceId);
  const branchId = m.get(META.branchId);
  const invoicePrefix = m.get(META.invoicePrefix);
  if (deviceId === undefined || branchId === undefined || invoicePrefix === undefined)
    throw new ServiceError('NOT_SETUP', 'Shop has not been set up yet');
  const bps = Number(m.get(META.cashierMaxDiscountBps) ?? DEFAULT_CASHIER_MAX_DISCOUNT_BPS);
  const type = BusinessTypeSchema.safeParse(m.get(META.businessType));
  const rawModules = m.get(META.modules);
  return {
    deviceId,
    branchId,
    invoicePrefix,
    setupAt: Number(m.get(META.setupAt) ?? 0),
    isDemo: m.get(META.demoData) === '1',
    businessType: type.success ? type.data : 'custom',
    modules: rawModules === undefined ? [...MODULE_IDS] : parseModuleList(rawModules),
    settings: {
      shopName: m.get(META.shopName) ?? '',
      address: m.get(META.shopAddress) ?? null,
      phone: m.get(META.shopPhone) ?? null,
      receiptFooter: m.get(META.receiptFooter) ?? null,
      receiptFooterUr: m.get(META.receiptFooterUr) ?? null,
      cashierMaxDiscountBps: Number.isInteger(bps) ? bps : DEFAULT_CASHIER_MAX_DISCOUNT_BPS,
      allowNegativeStock: m.get(META.allowNegativeStock) === '1',
    },
  };
}

export const upsertMeta = (key: string, value: string): Statement => ({
  sql: 'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  params: [key, value],
});

export const deleteMeta = (key: string): Statement => ({
  sql: 'DELETE FROM app_meta WHERE key = ?',
  params: [key],
});
