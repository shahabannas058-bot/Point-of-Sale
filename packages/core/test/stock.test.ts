import { describe, expect, it } from 'vitest';
import { assertSellable, onHandByItem, stockOnHand, type MovementLike } from '@pos/core';
import { expectDomainError, makeIdGenerator, mulberry32, randInt } from './fixtures';

const gen = makeIdGenerator(5);
const V = gen();
const B1 = gen();
const B2 = gen();

const itemMove = (quantity: number, branch: string = B1, item: string = V): MovementLike =>
  ({ branchId: branch, itemId: item, quantity }) as unknown as MovementLike;

const shopLedger = (): MovementLike[] => [
  itemMove(10), // purchase
  itemMove(-3), // sale
  itemMove(-2), // sale
  itemMove(1), // return
  itemMove(-1), // adjustment
];

describe('stockOnHand', () => {
  it('is the sum of the ledger: +10 -3 -2 +1 -1 = 5', () => {
    expect(stockOnHand(shopLedger(), { itemId: V, branchId: B1 })).toBe(5);
  });

  it('handles a branch transfer', () => {
    const movements = [...shopLedger(), itemMove(-4, B1), itemMove(4, B2)];
    expect(stockOnHand(movements, { itemId: V, branchId: B1 })).toBe(1);
    expect(stockOnHand(movements, { itemId: V, branchId: B2 })).toBe(4);
    expect(stockOnHand(movements, { itemId: V })).toBe(5);
  });

  it('ignores other items', () => {
    const other = gen();
    const movements = [...shopLedger(), itemMove(99, B1, other)];
    expect(stockOnHand(movements, { itemId: V })).toBe(5);
    expect(stockOnHand(movements, { itemId: other })).toBe(99);
  });

  it('does not depend on movement order (20 shuffles)', () => {
    const rand = mulberry32(3);
    const base = [...shopLedger(), itemMove(-4, B1), itemMove(4, B2)];
    for (let round = 0; round < 20; round++) {
      const shuffled = [...base];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randInt(rand, 0, i);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(stockOnHand(shuffled, { itemId: V, branchId: B1 })).toBe(1);
      expect(stockOnHand(shuffled, { itemId: V, branchId: B2 })).toBe(4);
      expect(stockOnHand(shuffled, { itemId: V })).toBe(5);
    }
  });

  it('detects a sum beyond the safe-integer range', () => {
    const huge = [itemMove(Number.MAX_SAFE_INTEGER), itemMove(Number.MAX_SAFE_INTEGER)];
    expectDomainError(() => stockOnHand(huge, { itemId: V }), 'STOCK_INVALID');
  });
});

describe('onHandByItem', () => {
  it('matches a reference sum for 10,000 random movements', () => {
    const rand = mulberry32(777);
    const items = [gen(), gen(), gen(), gen(), gen()];
    const movements: MovementLike[] = [];
    const reference = new Map<string, number>();
    for (let i = 0; i < 10_000; i++) {
      const qty = randInt(rand, -20, 20) || 1;
      const v = items[randInt(rand, 0, items.length - 1)]!;
      movements.push(itemMove(qty, B1, v));
      reference.set(v, (reference.get(v) ?? 0) + qty);
    }
    const result = onHandByItem(movements);
    expect([...result.keys()].sort()).toEqual([...reference.keys()].sort());
    for (const [key, value] of reference) expect(result.get(key)).toBe(value);
  });

  it('can be restricted to one branch', () => {
    const movements = [itemMove(5, B1), itemMove(7, B2)];
    expect(onHandByItem(movements, B1).get(V)).toBe(5);
    expect(onHandByItem(movements, B2).get(V)).toBe(7);
    expect(onHandByItem(movements).get(V)).toBe(12);
  });
});

describe('assertSellable', () => {
  const key = { itemId: V, branchId: B1 };
  const five = (): MovementLike[] => [itemMove(5)];

  it('blocks selling more than on hand', () => {
    expectDomainError(() => assertSellable(five(), key, 6), 'STOCK_INSUFFICIENT');
  });

  it('allows selling exactly what is on hand', () => {
    expect(() => assertSellable(five(), key, 5)).not.toThrow();
  });

  it('allows overselling when allowNegative is set', () => {
    expect(() => assertSellable(five(), key, 6, true)).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects sell quantity %s', (quantity) => {
    expectDomainError(() => assertSellable(five(), key, quantity), 'STOCK_INVALID');
    expectDomainError(() => assertSellable(five(), key, quantity, true), 'STOCK_INVALID');
  });
});
