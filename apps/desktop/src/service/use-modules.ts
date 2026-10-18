import { hasModule, type BusinessType, type ModuleId } from '@pos/shared';
import { useServiceQuery } from './use-query';

export interface ShopModules {
  /** undefined until the shop has been read. */
  modules: readonly ModuleId[] | undefined;
  businessType: BusinessType | undefined;
  /** False until the shop is known, so a gated screen never flashes for a shop that does not own it. */
  has: (id: ModuleId) => boolean;
}

/** The optional feature packs this shop owns (ADR-0003). `core` is always on and is not a module. */
export function useShopModules(): ShopModules {
  const shop = useServiceQuery((s) => s.setup.getShop(), []);
  const modules = shop.data?.modules;
  return {
    modules,
    businessType: shop.data?.businessType,
    has: (id) => modules !== undefined && hasModule(modules, id),
  };
}
