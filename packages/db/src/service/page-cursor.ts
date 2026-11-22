import type { SqlValue } from '../types';
import { intIn, invalid } from './errors';

/** Cursor of a newest-first list ordered by (created_at DESC, id DESC): the last row the caller already has. */
export interface NewestFirstCursor {
  beforeCreatedAt?: number;
  beforeId?: string;
}

/**
 * WHERE fragment for the rows after the cursor. With `beforeId` rows that share the cursor's created_at are split by
 * id, so they are neither skipped nor repeated; with `beforeCreatedAt` alone the rows are strictly older.
 * No cursor gives an always-true fragment. `alias` is the table alias with its dot, e.g. 's.'.
 */
export function olderThan(c: NewestFirstCursor, alias = ''): { sql: string; params: SqlValue[] } {
  const raw = c.beforeCreatedAt ?? null;
  if (raw === null) return { sql: '1 = 1', params: [] };
  const at = intIn(raw, 'beforeCreatedAt', 0, Number.MAX_SAFE_INTEGER);
  const id = c.beforeId ?? null;
  if (id === null) return { sql: `${alias}created_at < ?`, params: [at] };
  if (typeof id !== 'string' || id === '') throw invalid('beforeId', 'beforeId must be an id');
  return {
    sql: `(${alias}created_at < ? OR (${alias}created_at = ? AND ${alias}id < ?))`,
    params: [at, at, id],
  };
}
