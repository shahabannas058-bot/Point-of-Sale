import { describe, expect, it } from 'vitest';
import { daysBetween, isValidYmd, pktDate } from '../src/dates';

describe('pktDate', () => {
  it('gives the calendar date in Pakistan time (UTC+5)', () => {
    expect(pktDate(Date.UTC(2026, 0, 1, 12, 0))).toBe('2026-01-01');
  });

  it('rolls over to the next day at 19:00 UTC, which is midnight in Pakistan', () => {
    expect(pktDate(Date.UTC(2026, 0, 1, 18, 59, 59))).toBe('2026-01-01');
    expect(pktDate(Date.UTC(2026, 0, 1, 19, 0, 0))).toBe('2026-01-02');
  });

  it('crosses month and year ends', () => {
    expect(pktDate(Date.UTC(2026, 11, 31, 20, 0))).toBe('2027-01-01');
    expect(pktDate(Date.UTC(2028, 1, 28, 20, 0))).toBe('2028-02-29'); // leap year
  });
});

describe('isValidYmd', () => {
  it('accepts real dates', () => {
    expect(isValidYmd('2026-10-18')).toBe(true);
    expect(isValidYmd('2028-02-29')).toBe(true);
  });

  it('rejects impossible dates and other formats', () => {
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-1-5']) {
      expect(isValidYmd(bad), bad).toBe(false);
    }
    for (const bad of ['', 'kal', '12/05/2026', '2026-10-18T00:00:00Z', ' 2026-10-18']) {
      expect(isValidYmd(bad), bad).toBe(false);
    }
    expect(isValidYmd(20261018)).toBe(false);
  });
});

describe('daysBetween', () => {
  it('counts whole calendar days, negative when the second date is earlier', () => {
    expect(daysBetween('2026-10-18', '2026-10-18')).toBe(0);
    expect(daysBetween('2026-10-18', '2026-10-28')).toBe(10);
    expect(daysBetween('2026-10-18', '2026-10-15')).toBe(-3);
  });

  it('is exact across month ends, leap days and year ends', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2027-02-28', '2027-03-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});
