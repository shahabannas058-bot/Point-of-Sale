import type { PaymentMethod } from '@pos/shared';

/** One payment row as the panel parsed it (`paisa` null when the amount box is not a number). */
export interface PaymentRowValue {
  method: PaymentMethod;
  paisa: number | null;
}

/**
 * Whether the payment rows may be sent: every amount positive, the sum exactly the total, khata only with a
 * customer. A bill whose total is 0 (full discount) is paid with no rows at all (`payments: []`).
 */
export function paymentReady(
  rows: readonly PaymentRowValue[],
  total: number,
  hasCustomer: boolean,
): boolean {
  if (rows.length === 0) return total === 0;
  if (rows.some((r) => r.paisa === null || r.paisa <= 0)) return false;
  if (rows.some((r) => r.method === 'khata') && !hasCustomer) return false;
  return rows.reduce((a, r) => a + (r.paisa ?? 0), 0) === total;
}
