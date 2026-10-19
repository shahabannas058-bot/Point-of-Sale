import type { TKey } from './index';

/**
 * Wording that only makes sense in a mobile shop (IMEI, phones, accessories) and its plain-items twin.
 * A shop that does not own the `imei` module (kiryana, general store) must never see the left column.
 * While the shop is still loading the items wording is used, so a kiryana screen never flashes "IMEI".
 */
const ITEM_WORDING: Partial<Record<TKey, TKey>> = {
  'login.tagline': 'login.tagline.items',
  'billing.searchPlaceholder': 'billing.searchPlaceholder.items',
  'billing.emptyHint': 'billing.emptyHint.items',
  'inv.searchPlaceholder': 'inv.searchPlaceholder.items',
  'inv.noPhonesHint': 'inv.noPhonesHint.items',
  'inv.noAccessories': 'inv.noAccessories.items',
  'inv.editAccessory': 'inv.editAccessory.items',
  'sales.searchPlaceholder': 'sales.searchPlaceholder.items',
  'recv.addAccessory': 'recv.addAccessory.items',
  'recv.errAccessory': 'recv.errAccessory.items',
  'recv.errEmpty': 'recv.errEmpty.items',
  'settings.allowNegative': 'settings.allowNegative.items',
};

/** The key to translate: `key` itself for a shop with phones, its plain-items twin otherwise. */
export function nicheKey(hasImei: boolean, key: TKey): TKey {
  if (hasImei) return key;
  return ITEM_WORDING[key] ?? key;
}

/** Every mobile-only key, for the parity test. */
export const NICHE_KEYS = Object.keys(ITEM_WORDING) as TKey[];
