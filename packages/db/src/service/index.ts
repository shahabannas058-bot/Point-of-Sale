import type { PosService } from '@pos/shared';
import { authApi, settingsApi, setupApi } from './auth';
import { catalogApi } from './catalog';
import { checkoutApi } from './checkout';
import { createCtx, type ServiceOptions } from './context';
import { khataApi, purchasingApi } from './parties';
import { integrityApi, reportsApi } from './reports';
import { repairsApi } from './repairs';
import { warrantyApi } from './warranty';

export type { LicenceHook, ServiceOptions } from './context';
export { mapError } from './errors';
export { hashPin, verifyPin } from './auth';
export { seedDemoData } from './seed';

/** The whole POS backend over any SqlDriver (sql.js in the browser, better-sqlite3 in tests, C# via WebView2). */
export function createPosService(options: ServiceOptions): PosService {
  const ctx = createCtx(options);
  return {
    setup: setupApi(ctx),
    settings: settingsApi(ctx),
    auth: authApi(ctx),
    catalog: catalogApi(ctx),
    purchasing: purchasingApi(ctx),
    checkout: checkoutApi(ctx),
    khata: khataApi(ctx),
    reports: reportsApi(ctx),
    integrity: integrityApi(ctx),
    repairs: repairsApi(ctx),
    warranty: warrantyApi(ctx),
  };
}
