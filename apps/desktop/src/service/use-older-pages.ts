import { useEffect, useRef, useState } from 'react';
import { describeError, log } from '@pos/shared';
import { loadAllPages, nextPageCursor, type PageCursor, type RowKey } from '../lib/paging';

export interface OlderPages<T> {
  /** The first page followed by every older page loaded so far. */
  rows: T[];
  /** More rows exist after the last one shown. */
  hasMore: boolean;
  /** A "load older" reached the end: nothing older is left to show. */
  ended: boolean;
  busy: boolean;
  error: unknown;
  /** Loads the next older page. False when it failed (`error` says why). */
  loadMore: () => Promise<boolean>;
  /** Loads every older page (for printing the whole list). False when it failed. */
  loadAll: () => Promise<boolean>;
}

/**
 * "Load older" under a newest-first list whose first page comes from useServiceQuery. A new first page
 * (other filter, or any write) drops the older pages, and a late answer for an earlier first page is ignored.
 */
export function useOlderPages<T>(
  first: T[] | undefined,
  limit: number,
  key: RowKey<T>,
  fetchPage: (cursor: PageCursor) => Promise<T[]>,
): OlderPages<T> {
  const [older, setOlder] = useState<{ rows: T[]; cursor: PageCursor | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const generation = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    generation.current += 1;
    setOlder(null);
    setError(undefined);
  }, [first]);

  const cursor = older ? older.cursor : nextPageCursor(first ?? [], limit, key);

  const load = async (all: boolean): Promise<boolean> => {
    if (!cursor) return true;
    if (busy) return false;
    const gen = generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const rows = all
        ? await loadAllPages(fetchRef.current, cursor, limit, key)
        : await fetchRef.current(cursor);
      if (gen !== generation.current) return false;
      const next = all ? null : nextPageCursor(rows, limit, key);
      setOlder((o) => ({ rows: [...(o?.rows ?? []), ...rows], cursor: next }));
      return true;
    } catch (e: unknown) {
      log.warn('olderPages.load.failed', { error: describeError(e) });
      if (gen === generation.current) setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    rows: older ? [...(first ?? []), ...older.rows] : (first ?? []),
    hasMore: cursor !== null,
    ended: older !== null && older.cursor === null,
    busy,
    error,
    loadMore: () => load(false),
    loadAll: () => load(true),
  };
}
