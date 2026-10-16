import type { PosService } from '@pos/shared';
import { createAuthApi } from './auth';
import { createCatalogApi } from './catalog';
import { createCheckoutPart } from './checkout';
import { createCtx, type ServiceDeps } from './deps';
import { createIntegrityApi } from './integrity';
import { createKhataApi } from './khata';
import { createPurchasingApi } from './purchasing';
import { createReportsApi } from './reports';
import { createReturnsPart } from './returns';
import { createSettingsApi } from './settings';
import { createSetupApi } from './setup';

/** Composes the nine APIs of the contract over one driver. Each service instance has its own session/lock. */
export function createPosService(deps: ServiceDeps): PosService {
  const ctx = createCtx(deps);
  return {
    setup: createSetupApi(ctx),
    settings: createSettingsApi(ctx),
    auth: createAuthApi(ctx),
    catalog: createCatalogApi(ctx),
    purchasing: createPurchasingApi(ctx),
    checkout: { ...createCheckoutPart(ctx), ...createReturnsPart(ctx) },
    khata: createKhataApi(ctx),
    reports: createReportsApi(ctx),
    integrity: createIntegrityApi(ctx),
  };
}
