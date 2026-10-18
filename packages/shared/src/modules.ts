import { z } from 'zod';

/**
 * Optional feature packs a shop may own. `core` (billing, stock ledger, returns, khata, reports, users) is always on
 * and is not listed. The licence token carries the list; PosService rejects a call to a module the shop does not own.
 * Ids marked "reserved" exist so licences and presets can name them before the feature ships.
 */
export const MODULE_IDS = [
  'weight_units', // kiryana: loose goods sold by kg / litre
  'batch_expiry', // kiryana: reserved
  'imei', //         mobile + laptop: per-unit IMEI / serial phones
  'warranty', //     mobile + laptop: warranty by IMEI
  'repair', //       mobile + laptop: repair job tickets
  'tradein', //      mobile: reserved
  'easyload', //     mobile: reserved
  'agent_register', // mobile: reserved
  'installment', //  reserved
] as const;
export const ModuleIdSchema = z.enum(MODULE_IDS);
export type ModuleId = z.infer<typeof ModuleIdSchema>;

export const BUSINESS_TYPES = ['kiryana', 'mobile', 'laptop', 'custom'] as const;
export const BusinessTypeSchema = z.enum(BUSINESS_TYPES);
export type BusinessType = z.infer<typeof BusinessTypeSchema>;

/** Starting module set per business type; the owner can adjust it per shop in the admin panel. */
export const MODULE_PRESETS: Record<BusinessType, readonly ModuleId[]> = {
  kiryana: ['weight_units', 'batch_expiry'],
  mobile: ['imei', 'warranty', 'repair', 'tradein', 'easyload', 'agent_register', 'installment'],
  laptop: ['imei', 'warranty', 'repair'],
  custom: MODULE_IDS,
};

export const hasModule = (modules: readonly ModuleId[], id: ModuleId): boolean =>
  modules.includes(id);

/** Parses the stored comma-separated list; unknown ids are dropped so an older app never crashes on a newer licence. */
export function parseModuleList(raw: string): ModuleId[] {
  const known = new Set<string>(MODULE_IDS);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ModuleId => known.has(s));
}
export const formatModuleList = (modules: readonly ModuleId[]): string => modules.join(',');
