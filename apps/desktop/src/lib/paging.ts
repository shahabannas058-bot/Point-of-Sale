/**
 * "Load older" paging over the service's newest-first lists (ledgers, invoices). The next page starts after the
 * last row shown: its createdAt and id, so rows that share a timestamp are neither skipped nor repeated.
 */

export interface PageCursor {
  beforeCreatedAt: number;
  beforeId: string;
}

/** Picks the row's own timestamp and id (an invoice) or its entry's (a ledger line). */
export type RowKey<T> = (row: T) => { createdAt: number; id: string };

/** The cursor for the page after `rows`, or null when `rows` was shorter than `limit` (nothing older is left). */
export function nextPageCursor<T>(
  rows: readonly T[],
  limit: number,
  key: RowKey<T>,
): PageCursor | null {
  const last = rows[rows.length - 1];
  if (last === undefined || rows.length < limit) return null;
  const k = key(last);
  return { beforeCreatedAt: k.createdAt, beforeId: k.id };
}

/** Every row older than `cursor`, one page after another (for printing a whole statement). */
export async function loadAllPages<T>(
  fetchPage: (cursor: PageCursor) => Promise<T[]>,
  cursor: PageCursor | null,
  limit: number,
  key: RowKey<T>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let c = cursor; c !== null;) {
    const page = await fetchPage(c);
    rows.push(...page);
    c = nextPageCursor(page, limit, key);
  }
  return rows;
}
