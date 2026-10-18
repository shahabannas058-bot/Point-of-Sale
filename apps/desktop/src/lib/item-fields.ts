import { hasModule, type ModuleId } from '@pos/shared';

/**
 * "Fits model" (an iPhone 13 cover) and colour describe mobile accessories. A shop without the `imei` module (a
 * kiryana / grocery shop) never sees them: not in the add-item dialog and not as columns in the stock list.
 * While the shop's modules are still loading they are shown, so a mobile shop does not see them flicker away.
 */
export const showsModelAndColour = (modules: readonly ModuleId[] | undefined): boolean =>
  modules === undefined || hasModule(modules, 'imei');
