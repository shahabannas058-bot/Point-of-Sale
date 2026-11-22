import { describe, expect, it } from 'vitest';
import {
  daysSince,
  formatMonth,
  inclusiveBounds,
  pktMonthRange,
  monthYm,
  shiftMonth,
} from '../src/lib/dates';

/** An instant on the Pakistan wall clock (UTC+5); the suite itself runs in UTC. */
const pkt = (y: number, m0: number, d: number, h = 0, min = 0): number =>
  Date.UTC(y, m0, d, h, min) - 5 * 3_600_000;

describe('month helpers (Pakistan time, no DST)', () => {
  it('monthYm names the month a timestamp falls in', () => {
    expect(monthYm(pkt(2026, 9, 19, 13, 0))).toBe('2026-10');
    expect(monthYm(pkt(2026, 0, 1, 0, 0))).toBe('2026-01');
  });

  it('pktMonthRange runs from the 1st 00:00 to the next 1st 00:00', () => {
    const r = pktMonthRange('2026-10');
    expect(r).toEqual({ fromMs: pkt(2026, 9, 1), toMs: pkt(2026, 10, 1) });
    expect(pktMonthRange('2026-12').toMs).toBe(pkt(2027, 0, 1));
  });

  it('inclusiveBounds ends one ms before the next month, so 1st 00:00 is in one month only (QA#17)', () => {
    const oct = inclusiveBounds(pktMonthRange('2026-10'));
    const novStart = pktMonthRange('2026-11').fromMs;
    expect(oct).toEqual({ from: pktMonthRange('2026-10').fromMs, to: novStart - 1 });
    expect(novStart <= oct.to).toBe(false);
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
    const now = pkt(2026, 9, 19);
    expect(daysSince(now - 3.9 * 86_400_000, now)).toBe(3);
    expect(daysSince(now + 1000, now)).toBe(0);
  });
});
