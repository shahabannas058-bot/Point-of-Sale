import type { SummaryRange } from '@pos/shared';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local-day bounds [from, to) for a YYYY-MM-DD string (PKT has no DST, so +24h is exact). */
export function localDayRange(ymd: string): SummaryRange {
  const [y = 1970, m = 1, d = 1] = ymd.split('-').map(Number);
  const from = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const to = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  return { fromMs: from, toMs: to };
}

export function todayYmd(now: number = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 14:05 style, 24h Latin digits. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 11-10-2026 style (dd-mm-yyyy), Latin digits. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

export const formatDateTime = (ms: number): string => `${formatDate(ms)} ${formatTime(ms)}`;

/** "2026-10" for the month `now` falls in. */
export function monthYm(now: number = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Local-month bounds [first day 00:00, first day of next month 00:00) for a YYYY-MM string. */
export function localMonthRange(ym: string): SummaryRange {
  const [y = 1970, m = 1] = ym.split('-').map(Number);
  return {
    fromMs: new Date(y, m - 1, 1, 0, 0, 0, 0).getTime(),
    toMs: new Date(y, m, 1, 0, 0, 0, 0).getTime(),
  };
}

/** "2026-10" + 1 -> "2026-11"; -1 -> "2026-09". Rolls over the year. */
export function shiftMonth(ym: string, delta: number): string {
  const [y = 1970, m = 1] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 2026" for a YYYY-MM string (Latin script in both languages). */
export function formatMonth(ym: string): string {
  const [y = 1970, m = 1] = ym.split('-').map(Number);
  return `${MONTHS[m - 1] ?? '?'} ${y}`;
}

/** Whole days from `sinceMs` to `now`, never negative. */
export const daysSince = (sinceMs: number, now: number = Date.now()): number =>
  Math.max(0, Math.floor((now - sinceMs) / 86_400_000));
