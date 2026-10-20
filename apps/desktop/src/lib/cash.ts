import type { DrawerBreakdown } from '@pos/shared';

export type DrawerRowKey = Exclude<keyof DrawerBreakdown, 'expected'>;
export interface DrawerRow {
  key: DrawerRowKey;
  /** Signed effect on the drawer: money in is positive, money out negative. */
  value: number;
}

const IN: readonly DrawerRowKey[] = [
  'opening',
  'cashSales',
  'udhaarCollected',
  'repairCash',
  'cashIn',
];
const ORDER: readonly DrawerRowKey[] = [
  'opening',
  'cashSales',
  'cashRefunds',
  'udhaarCollected',
  'supplierPaid',
  'repairCash',
  'expenses',
  'cashIn',
  'cashOut',
];
/** Always shown, even at zero, so the shopkeeper sees the usual lines every day. */
const ALWAYS: readonly DrawerRowKey[] = ['opening', 'cashSales', 'expenses'];

/** The lines that make up the expected cash, in reading order; rare lines are hidden while they are zero. */
export function drawerRows(b: DrawerBreakdown): DrawerRow[] {
  return ORDER.filter((key) => b[key] !== 0 || ALWAYS.includes(key)).map((key) => ({
    key,
    value: IN.includes(key) ? b[key] : 0 - b[key],
  }));
}

/** 0 <= carried <= counted, both whole paisa; null when either is not entered yet. */
export function closeInputError(
  counted: number | null,
  carried: number | null,
): 'counted' | 'carried' | null {
  if (counted === null || counted < 0) return 'counted';
  if (carried === null || carried < 0 || carried > counted) return 'carried';
  return null;
}
