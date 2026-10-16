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
