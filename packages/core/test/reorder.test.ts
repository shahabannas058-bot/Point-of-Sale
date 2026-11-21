import { describe, expect, it } from 'vitest';
import { compareReorder, reorderFigures } from '../src/reorder';

const base = { reorderLevel: 5, days: 30, coverDays: 14, leadDays: 7 };

describe('reorderFigures', () => {
  it('uses integer maths, so 38 on hand at 2 sold / 30 days lasts exactly 570 days', () => {
    // 38 / (2 / 30) is 569.999... in floating point
    expect(reorderFigures({ ...base, onHand: 38, sold: 2 })).toEqual({
      dailyAvg: 0.07,
      daysLeft: 570,
      suggestedQty: 0, // 5 + ceil(2 * 14 / 30) - 38 < 0
      needsReorder: false,
    });
  });

  it('suggests reorder level + cover days of sales minus stock', () => {
    // 46 sold in 30 days, 6 on hand: lasts floor(6 * 30 / 46) = 3 days; cover ceil(46 * 14 / 30) = 22
    expect(reorderFigures({ ...base, onHand: 6, sold: 46 })).toEqual({
      dailyAvg: 1.53,
      daysLeft: 3,
      suggestedQty: 5 + 22 - 6,
      needsReorder: true,
    });
  });

  it('flags items at or below the level even when nothing sold', () => {
    expect(reorderFigures({ ...base, onHand: 5, sold: 0 })).toEqual({
      dailyAvg: 0,
      daysLeft: null,
      suggestedQty: 0,
      needsReorder: true,
    });
    expect(reorderFigures({ ...base, onHand: 2, sold: 0 }).suggestedQty).toBe(3);
    expect(reorderFigures({ ...base, onHand: 6, sold: 0 }).needsReorder).toBe(false);
  });

  it('treats negative stock as empty and the lead-time edge as inclusive', () => {
    expect(reorderFigures({ ...base, onHand: -2, sold: 3 }).daysLeft).toBe(0);
    // 7 on hand at 1 a day: exactly 7 days left -> reorder
    expect(reorderFigures({ ...base, onHand: 7, sold: 30 }).needsReorder).toBe(true);
    expect(reorderFigures({ ...base, onHand: 8, sold: 30 }).needsReorder).toBe(false);
  });
});

describe('compareReorder', () => {
  it('orders by days left (unknown last), then gap below level, then name', () => {
    const r = (label: string, daysLeft: number | null, onHand: number) => ({
      label,
      daysLeft,
      onHand,
      reorderLevel: 5,
    });
    const rows = [r('d', null, 0), r('c', null, 4), r('b', 3, 9), r('a', 1, 9), r('e', null, 0)];
    expect(rows.sort(compareReorder).map((x) => x.label)).toEqual(['a', 'b', 'd', 'e', 'c']);
  });
});
