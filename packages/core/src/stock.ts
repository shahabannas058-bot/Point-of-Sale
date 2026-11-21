import type { StockMovement } from '@pos/shared';
import { DomainError } from './errors';

export type MovementLike = Pick<StockMovement, 'branchId' | 'variantId' | 'quantity'>;
export interface StockKey {
  variantId: string;
  branchId?: string;
}

/** Quantity on hand = SUM(quantity) over matching movements. Order-independent. branchId omitted = all branches. */
export function stockOnHand(movements: readonly MovementLike[], key: StockKey): number {
  let sum = 0;
  for (const m of movements) {
    if (m.variantId !== key.variantId) continue;
    if (key.branchId !== undefined && m.branchId !== key.branchId) continue;
    sum += m.quantity;
  }
  if (!Number.isSafeInteger(sum)) throw new DomainError('STOCK_INVALID', 'Stock sum overflow');
  return sum;
}

/** On hand per variant id (optionally restricted to one branch). */
export function onHandByItem(
  movements: readonly MovementLike[],
  branchId?: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of movements) {
    if (branchId !== undefined && m.branchId !== branchId) continue;
    out.set(m.variantId, (out.get(m.variantId) ?? 0) + m.quantity);
  }
  return out;
}

export function assertSellable(
  movements: readonly MovementLike[],
  key: StockKey,
  quantity: number,
  allowNegative = false,
): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0)
    throw new DomainError(
      'STOCK_INVALID',
      `Sell quantity must be a positive integer, got ${String(quantity)}`,
    );
  const onHand = stockOnHand(movements, key);
  if (!allowNegative && onHand - quantity < 0)
    throw new DomainError('STOCK_INSUFFICIENT', `On hand ${onHand}, requested ${quantity}`);
}
