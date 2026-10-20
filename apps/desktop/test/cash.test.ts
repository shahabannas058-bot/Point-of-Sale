import { describe, expect, it } from 'vitest';
import type { DrawerBreakdown } from '@pos/shared';
import { closeInputError, drawerRows } from '../src/lib/cash';

const zero = {
  opening: 0,
  cashSales: 0,
  cashRefunds: 0,
  udhaarCollected: 0,
  supplierPaid: 0,
  repairCash: 0,
  expenses: 0,
  cashIn: 0,
  cashOut: 0,
  expected: 0,
} as DrawerBreakdown;

describe('drawerRows', () => {
  it('shows the everyday lines even at zero and hides the rare ones', () => {
    expect(drawerRows(zero).map((r) => r.key)).toEqual(['opening', 'cashSales', 'expenses']);
  });

  it('signs money out as negative, and the rows add up to expected', () => {
    const b = {
      ...zero,
      opening: 500,
      cashSales: 10_000,
      cashRefunds: 1_000,
      udhaarCollected: 2_000,
      supplierPaid: 3_000,
      repairCash: -400,
      expenses: 600,
      cashIn: 700,
      cashOut: 800,
      expected: 7_400,
    } as DrawerBreakdown;
    const rows = drawerRows(b);
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ['opening', 500],
      ['cashSales', 10_000],
      ['cashRefunds', -1_000],
      ['udhaarCollected', 2_000],
      ['supplierPaid', -3_000],
      ['repairCash', -400],
      ['expenses', -600],
      ['cashIn', 700],
      ['cashOut', -800],
    ]);
    expect(rows.reduce((a, r) => a + r.value, 0)).toBe(b.expected);
  });
});

describe('closeInputError', () => {
  it('needs a count, and leaves at most the counted cash in the drawer', () => {
    expect(closeInputError(null, 0)).toBe('counted');
    expect(closeInputError(-1, 0)).toBe('counted');
    expect(closeInputError(1_000, null)).toBe('carried');
    expect(closeInputError(1_000, 1_001)).toBe('carried');
    expect(closeInputError(1_000, -1)).toBe('carried');
    expect(closeInputError(1_000, 1_000)).toBeNull();
    expect(closeInputError(0, 0)).toBeNull();
  });
});
