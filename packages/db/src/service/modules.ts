import { ServiceError, hasModule, type ModuleId } from '@pos/shared';
import type { Ctx } from './deps';
import { loadShop } from './meta';

/** Throws MODULE_DISABLED unless the shop owns the module. `core` needs no module and is never checked. */
export function assertModule(modules: readonly ModuleId[], id: ModuleId): void {
  if (!hasModule(modules, id))
    throw new ServiceError('MODULE_DISABLED', `This shop does not have the "${id}" module`, {
      module: id,
    });
}

/**
 * Wraps every method of an API object so it first checks the module. Reads the shop fresh each call, so a licence
 * that adds or removes a module takes effect without restarting the app.
 */
export function requireModuleApi<T extends object>(ctx: Ctx, id: ModuleId, api: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(api) as [string, unknown][]) {
    if (typeof value !== 'function') {
      out[key] = value;
      continue;
    }
    const fn = value as (...args: unknown[]) => unknown;
    out[key] = async (...args: unknown[]): Promise<unknown> => {
      assertModule((await loadShop(ctx.driver)).modules, id);
      return fn(...args);
    };
  }
  return out as T;
}
