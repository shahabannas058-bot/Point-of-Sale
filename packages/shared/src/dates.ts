/**
 * Calendar dates as `YYYY-MM-DD` strings in Pakistan time (UTC+5, no daylight saving). Used for batch expiry: an expiry
 * date is a day, not a moment, and the shop's day ends at Pakistan midnight whatever the PC's time zone says.
 */
const PKT_OFFSET_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;

/** The Pakistan calendar date of a UTC timestamp in milliseconds. */
export const pktDate = (ms: number): string =>
  new Date(ms + PKT_OFFSET_MS).toISOString().slice(0, 10);

/** True for a real calendar date written exactly as YYYY-MM-DD (so not 2026-02-30, not 2026-1-5). */
export function isValidYmd(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). Both must be valid YYYY-MM-DD dates. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
