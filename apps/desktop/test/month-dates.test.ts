import { describe, expect, it } from 'vitest';
import { daysSince, formatMonth, localMonthRange, monthYm, shiftMonth } from '../src/lib/dates';

describe('month helpers (PKT has no DST, local midnight is exact)', () => {
  it('monthYm names the month a timestamp falls in', () => {
    expect(monthYm(new Date(2026, 9, 19, 13, 0).getTime())).toBe('2026-10');
    expect(monthYm(new Date(2026, 0, 1, 0, 0).getTime())).toBe('2026-01');
  });

  it('localMonthRange runs from the 1st 00:00 to the next 1st 00:00', () => {
    const r = localMonthRange('2026-10');
    expect(new Date(r.fromMs).toString()).toBe(new Date(2026, 9, 1).toString());
    expect(new Date(r.toMs).toString()).toBe(new Date(2026, 10, 1).toString());
    const dec = localMonthRange('2026-12');
    expect(new Date(dec.toMs).getFullYear()).toBe(2027);
  });

  it('shiftMonth rolls over the year both ways', () => {
    expect(shiftMonth('2026-10', 1)).toBe('2026-11');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('formatMonth is short Latin', () => {
    expect(formatMonth('2026-10')).toBe('Oct 2026');
  });

  it('daysSince floors and never goes negative', () => {
    const now = new Date(2026, 9, 19).getTime();
    expect(daysSince(now - 3.9 * 86_400_000, now)).toBe(3);
    expect(daysSince(now + 1000, now)).toBe(0);
  });
});
