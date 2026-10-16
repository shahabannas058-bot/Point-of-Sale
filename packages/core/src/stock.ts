import type { StockMovement } from '@pos/shared';
import { DomainError } from './errors';

export type MovementLike = Pick<
  StockMovement,
  'branchId' | 'phoneUnitId' | 'variantId' | 'quantity'
>;
export interface StockKey {
  variantId?: string;
  phoneUnitId?: string;
  branchId?: string;
}

/** Quantity on hand = SUM(quantity) over matching movements. Order-independent. branchId omitted = all branches. */
export function stockOnHand(movements: readonly MovementLike[], key: StockKey): number {
  if (key.variantId === undefined && key.phoneUnitId === undefined)
    throw new DomainError('STOCK_INVALID', 'stockOnHand needs variantId or phoneUnitId');
  let sum = 0;
  for (const m of movements) {
    if (key.variantId !== undefined && m.variantId !== key.variantId) continue;
    if (key.phoneUnitId !== undefined && m.phoneUnitId !== key.phoneUnitId) continue;
    if (key.branchId !== undefined && m.branchId !== key.branchId) continue;
    sum += m.quantity;
  }
  if (!Number.isSafeInteger(sum)) throw new DomainError('STOCK_INVALID', 'Stock sum overflow');
  return sum;
}

/** Map keyed 'variant:<id>' or 'unit:<id>' (optionally restricted to one branch). */
export function onHandByItem(
  movements: readonly MovementLike[],
  branchId?: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of movements) {
    if (branchId !== undefined && m.branchId !== branchId) continue;
    const key =
      m.variantId !== null
        ? `variant:${m.variantId}`
        : m.phoneUnitId !== null
          ? `unit:${m.phoneUnitId}`
          : null;
    if (key === null) throw new DomainError('STOCK_INVALID', 'Movement has no target');
    out.set(key, (out.get(key) ?? 0) + m.quantity);
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

/** A phone unit's movements must sum to 0 (out) or 1 (in stock); anything else means a corrupted ledger. */
export function phoneUnitState(
  movements: readonly MovementLike[],
  phoneUnitId: string,
): 'in_stock' | 'out' {
  const sum = stockOnHand(movements, { phoneUnitId });
  if (sum === 1) return 'in_stock';
  if (sum === 0) return 'out';
  throw new DomainError(
    'LEDGER_CORRUPT',
    `Phone unit ${phoneUnitId} has on-hand ${sum}; expected 0 or 1`,
  );
}
