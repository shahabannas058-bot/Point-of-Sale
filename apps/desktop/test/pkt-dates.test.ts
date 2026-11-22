import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatTime,
  pktDayRange,
  pktMonthRange,
  monthYm,
  todayYmd,
} from '../src/lib/dates';
import { periodBuckets } from '../src/lib/dashboard';

// The shop's day runs on Pakistan time (UTC+5) whatever time zone the PC is set to. The suite runs with TZ=UTC
// (root vitest.config.ts), so these fail if any helper falls back to the PC's local time.
const HOUR = 3_600_000;
const pkt = (y: number, m: number, d: number, h = 0, min = 0): number =>
  Date.UTC(y, m - 1, d, h, min) - 5 * HOUR;

describe('dates follow Pakistan time, not the PC clock zone (QA S9)', () => {
  it('a 02:00 PKT sale belongs to that PKT day', () => {
    const at = pkt(2026, 10, 19, 2, 0); // 2026-10-18 21:00 UTC
    expect(todayYmd(at)).toBe('2026-10-19');
    expect(formatDate(at)).toBe('19-10-2026');
    expect(formatTime(at)).toBe('02:00');
  });

  it('a day runs from PKT midnight to the next PKT midnight', () => {
    expect(pktDayRange('2026-10-19')).toEqual({
      fromMs: pkt(2026, 10, 19),
      toMs: pkt(2026, 10, 20),
    });
  });

  it('a month starts at PKT midnight on the 1st', () => {
    expect(pktMonthRange('2026-11')).toEqual({
      fromMs: pkt(2026, 11, 1),
      toMs: pkt(2026, 12, 1),
    });
    expect(monthYm(pkt(2026, 11, 1, 0, 30))).toBe('2026-11');
  });

  it('dashboard buckets start at PKT midnight', () => {
    const b = periodBuckets('week', pkt(2026, 10, 20, 1, 0));
    expect(b.buckets[0]).toBe(pkt(2026, 10, 14));
    expect(b.buckets[7]).toBe(pkt(2026, 10, 21));
    expect(b.labels[6]).toBe('20 Oct');
    const y = periodBuckets('year', pkt(2026, 10, 1, 1, 0));
    expect(y.buckets[0]).toBe(pkt(2025, 11, 1));
    expect(y.labels[11]).toBe('Oct');
  });
});
