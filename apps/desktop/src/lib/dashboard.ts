import type { PendingUdhaar } from '@pos/shared';
import { MONTHS } from './dates';

export type DashPeriod = 'week' | 'month' | 'year';
export const DASH_PERIODS: readonly DashPeriod[] = ['week', 'month', 'year'];

const DAYS_IN: Record<Exclude<DashPeriod, 'year'>, number> = { week: 7, month: 30 };
const MONTHS_IN_YEAR = 12;
/** A customer who has not paid for this many days counts as overdue. */
export const OVERDUE_DAYS = 30;
const DAY_MS = 86_400_000;

export interface Bucketing {
  /** Ascending boundaries; buckets[i]..buckets[i+1] is chart point i. */
  buckets: number[];
  labels: string[];
}

/** Local-day buckets for week / month, local-month buckets for year; the current day or month is the last point. */
export function periodBuckets(period: DashPeriod, now: number = Date.now()): Bucketing {
  const today = new Date(now);
  if (period === 'year') {
    const first = today.getMonth() - (MONTHS_IN_YEAR - 1);
    const starts = Array.from(
      { length: MONTHS_IN_YEAR + 1 },
      (_, i) => new Date(today.getFullYear(), first + i, 1),
    );
    return {
      buckets: starts.map((d) => d.getTime()),
      labels: starts.slice(0, -1).map((d) => MONTHS[d.getMonth()] ?? '?'),
    };
  }
  const days = DAYS_IN[period];
  const first = today.getDate() - (days - 1);
  const starts = Array.from(
    { length: days + 1 },
    (_, i) => new Date(today.getFullYear(), today.getMonth(), first + i),
  );
  return {
    buckets: starts.map((d) => d.getTime()),
    labels: starts.slice(0, -1).map((d) => `${d.getDate()} ${MONTHS[d.getMonth()] ?? '?'}`),
  };
}

/** The smallest 1 / 2 / 5 x 10^n at or above `v` (100 paisa at least), for a clean axis top. */
export function niceMax(v: number): number {
  if (v <= 100) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 5, 10].find((m) => m * p >= v) ?? 10;
  return step * p;
}

const COMPACT: readonly [number, string][] = [
  [10_000_000, 'Cr'],
  [100_000, 'L'],
  [1_000, 'K'],
];

/** Short rupee figure for chart axes: 950, 12.5K, 1.5L, 2.3Cr (input in paisa). */
export function compactRs(p: number): string {
  const rupees = Math.trunc(p / 100);
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? '-' : '';
  const unit = COMPACT.find(([size]) => abs >= size);
  if (!unit) return `${sign}${abs}`;
  const [size, suffix] = unit;
  const v = Math.round((abs / size) * 10) / 10;
  return `${sign}${String(v)}${suffix}`;
}

export interface UdhaarHealth {
  outstanding: number;
  customers: number;
  /** Balances of customers with no payment for OVERDUE_DAYS (or never paid, udhaar that old). */
  overdue: number;
  overdueCustomers: number;
  collected: number;
  /** collected / (collected + outstanding), 0..1. */
  collectionRate: number;
}

export function udhaarHealth(
  pending: readonly PendingUdhaar[],
  collected: number,
  now: number = Date.now(),
): UdhaarHealth {
  const cutoff = now - OVERDUE_DAYS * DAY_MS;
  const overdueRows = pending.filter((p) => (p.lastPaymentAt ?? p.lastCreditAt ?? now) < cutoff);
  const sum = (rows: readonly PendingUdhaar[]): number =>
    rows.reduce((acc, p) => acc + p.balance, 0);
  const outstanding = sum(pending);
  const base = collected + outstanding;
  return {
    outstanding,
    customers: pending.length,
    overdue: sum(overdueRows),
    overdueCustomers: overdueRows.length,
    collected,
    collectionRate: base > 0 ? collected / base : 0,
  };
}
