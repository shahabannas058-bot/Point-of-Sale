import { z } from 'zod';

/**
 * Optional feature packs a shop may own. `core` (billing, stock ledger, returns, khata, reports, users) is always on
 * and is not listed. The licence token carries the list; PosService rejects a call to a module the shop does not own.
 */
export const MODULE_IDS = [
  'weight_units', // kiryana: loose goods sold by kg / litre
  'batch_expiry', // kiryana: batches with expiry dates, first-expiry-first-out
] as const;
export const ModuleIdSchema = z.enum(MODULE_IDS);
export type ModuleId = z.infer<typeof ModuleIdSchema>;

export const BUSINESS_TYPES = ['kiryana'] as const;
export const BusinessTypeSchema = z.enum(BUSINESS_TYPES);
export type BusinessType = z.infer<typeof BusinessTypeSchema>;

/** Starting module set per business type; the owner can adjust it per shop in the admin panel. */
export const MODULE_PRESETS: Record<BusinessType, readonly ModuleId[]> = {
  kiryana: ['weight_units', 'batch_expiry'],
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
