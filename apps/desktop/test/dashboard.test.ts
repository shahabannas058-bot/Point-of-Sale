import { describe, expect, it } from 'vitest';
import type { Customer, Paisa, PendingUdhaar } from '@pos/shared';
import { compactRs, niceMax, periodBuckets, udhaarHealth } from '../src/lib/dashboard';

const DAY = 86_400_000;
/** An instant on the Pakistan wall clock (UTC+5); the suite itself runs in UTC. */
const pkt = (y: number, m0: number, d: number, h = 0, min = 0): number =>
  Date.UTC(y, m0, d, h, min) - 5 * 3_600_000;
// 20 Oct 2026 15:30 Pakistan time
const NOW = pkt(2026, 9, 20, 15, 30);

describe('periodBuckets', () => {
  it('week = the last 7 Pakistan days, today included, labelled by day', () => {
    const b = periodBuckets('week', NOW);
    expect(b.buckets).toHaveLength(8);
    expect(b.buckets[0]).toBe(pkt(2026, 9, 14));
    expect(b.buckets[7]).toBe(pkt(2026, 9, 21));
    expect(b.labels[0]).toBe('14 Oct');
    expect(b.labels[6]).toBe('20 Oct');
  });

  it('month = the last 30 Pakistan days', () => {
    const b = periodBuckets('month', NOW);
    expect(b.labels).toHaveLength(30);
    expect(b.buckets[30]).toBe(pkt(2026, 9, 21));
    expect(b.labels[0]).toBe('21 Sep');
  });

  it('year = the last 12 months, this month included, rolling over the year', () => {
    const b = periodBuckets('year', NOW);
    expect(b.labels).toEqual([
      'Nov',
      'Dec',
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
    ]);
    expect(b.buckets[0]).toBe(pkt(2025, 10, 1));
    expect(b.buckets[12]).toBe(pkt(2026, 10, 1));
  });
});

describe('niceMax', () => {
  it('rounds up to 1 / 2 / 5 x 10^n and never returns 0', () => {
    expect(niceMax(0)).toBe(100);
    expect(niceMax(87)).toBe(100);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(4_100)).toBe(5_000);
    expect(niceMax(5_000)).toBe(5_000);
    expect(niceMax(7_200_000)).toBe(10_000_000);
  });
});

describe('compactRs', () => {
  it('uses thousand, lakh and crore for rupees', () => {
    expect(compactRs(0)).toBe('0');
    expect(compactRs(95_000)).toBe('950');
    expect(compactRs(1_250_000)).toBe('12.5K');
    expect(compactRs(15_000_000)).toBe('1.5L');
    expect(compactRs(2_300_000_000)).toBe('2.3Cr');
    expect(compactRs(-1_000_000)).toBe('-10K');
  });
});

const customer = (id: string): Customer => ({ id, name: id }) as Customer;
const owes = (
  id: string,
  balance: number,
  lastCreditAt: number | null,
  lastPaymentAt: number | null,
  firstCreditAt: number | null = lastCreditAt,
): PendingUdhaar => ({
  party: customer(id),
  balance: balance as Paisa,
  firstCreditAt,
  lastCreditAt,
  lastPaymentAt,
});

describe('udhaarHealth', () => {
  it('adds what is owed, and counts as overdue whoever has not paid for 30 days', () => {
    const h = udhaarHealth(
      [
        owes('a', 50_000, NOW - 2 * DAY, NOW - 40 * DAY), // paid long ago -> overdue
        owes('b', 30_000, NOW - 45 * DAY, null), // never paid, udhaar 45 days old -> overdue
        owes('c', 20_000, NOW - 3 * DAY, null), // fresh udhaar
        owes('d', 10_000, NOW - 60 * DAY, NOW - 5 * DAY), // paid recently
      ],
      100_000,
      NOW,
    );
    expect(h).toEqual({
      outstanding: 110_000,
      customers: 4,
      overdue: 80_000,
      overdueCustomers: 2,
      collected: 100_000,
      collectionRate: 100_000 / 210_000,
    });
  });

  it('a customer who never paid is overdue from the first udhaar, not the latest (QA S11)', () => {
    // udhaar since 45 days, a small new purchase on khata 2 days ago, never a payment
    const h = udhaarHealth([owes('e', 40_000, NOW - 2 * DAY, null, NOW - 45 * DAY)], 0, NOW);
    expect(h.overdueCustomers).toBe(1);
    expect(h.overdue).toBe(40_000);
  });

  it('is 0% collected, not NaN, when nothing is owed or paid', () => {
    expect(udhaarHealth([], 0, NOW).collectionRate).toBe(0);
  });
});
