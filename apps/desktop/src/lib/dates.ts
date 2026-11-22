import type { SummaryRange } from '@pos/shared';

import { pktDate } from '@pos/shared';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The shop's calendar runs on Pakistan time (UTC+5, no daylight saving) whatever time zone the PC is set to, the same
 * rule as batch expiry (`pktDate`). A PC left on UTC must not file a 02:00 sale under the day before (QA S9).
 */
const PKT_OFFSET_MS = 5 * 3_600_000;

/** A Date whose UTC fields read as the Pakistan wall clock at `ms`. */
const pktClock = (ms: number): Date => new Date(ms + PKT_OFFSET_MS);

/** The instant of Pakistan midnight starting day `d` of month `m0` (0-based) of year `y`; fields may overflow. */
export const pktMidnight = (y: number, m0: number, d: number): number =>
  Date.UTC(y, m0, d) - PKT_OFFSET_MS;

/** Pakistan wall-clock fields of an instant. */
export function pktParts(ms: number): { y: number; m0: number; d: number } {
  const c = pktClock(ms);
  return { y: c.getUTCFullYear(), m0: c.getUTCMonth(), d: c.getUTCDate() };
}

/** Pakistan-day bounds [from, to) for a YYYY-MM-DD string (no DST, so +24h is exact). */
export function localDayRange(ymd: string): SummaryRange {
  const [y = 1970, m = 1, d = 1] = ymd.split('-').map(Number);
  return { fromMs: pktMidnight(y, m - 1, d), toMs: pktMidnight(y, m - 1, d + 1) };
}

/** Today's Pakistan date as YYYY-MM-DD. */
export const todayYmd = (now: number = Date.now()): string => pktDate(now);

/** 14:05 style, 24h Latin digits, Pakistan time. */
export function formatTime(ms: number): string {
  const c = pktClock(ms);
  return `${pad(c.getUTCHours())}:${pad(c.getUTCMinutes())}`;
}

/** 11-10-2026 style (dd-mm-yyyy), Latin digits, Pakistan date. */
export function formatDate(ms: number): string {
  const { y, m0, d } = pktParts(ms);
  return `${pad(d)}-${pad(m0 + 1)}-${y}`;
}

export const formatDateTime = (ms: number): string => `${formatDate(ms)} ${formatTime(ms)}`;

/** "2026-10" for the Pakistan month `now` falls in. */
export function monthYm(now: number = Date.now()): string {
  const { y, m0 } = pktParts(now);
  return `${y}-${pad(m0 + 1)}`;
}

/** Pakistan-month bounds [first day 00:00, first day of next month 00:00) for a YYYY-MM string. */
export function localMonthRange(ym: string): SummaryRange {
  const [y = 1970, m = 1] = ym.split('-').map(Number);
  return { fromMs: pktMidnight(y, m - 1, 1), toMs: pktMidnight(y, m, 1) };
}

/** A half-open [fromMs, toMs) range as the inclusive { from, to } bounds the service queries take. */
export const inclusiveBounds = (r: SummaryRange): { from: number; to: number } => ({
  from: r.fromMs,
  to: r.toMs - 1,
});

/** "2026-10" + 1 -> "2026-11"; -1 -> "2026-09". Rolls over the year. */
export function shiftMonth(ym: string, delta: number): string {
  const [y = 1970, m = 1] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export const MONTHS = [
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
  'Nov',
  'Dec',
];

/** "Oct 2026" for a YYYY-MM string (Latin script in both languages). */
export function formatMonth(ym: string): string {
  const [y = 1970, m = 1] = ym.split('-').map(Number);
  return `${MONTHS[m - 1] ?? '?'} ${y}`;
}

/** Whole days from `sinceMs` to `now`, never negative. */
export const daysSince = (sinceMs: number, now: number = Date.now()): number =>
  Math.max(0, Math.floor((now - sinceMs) / 86_400_000));
