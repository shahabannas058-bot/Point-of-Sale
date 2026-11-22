import type { SqlDriver, SqlValue, Statement } from '../src/types';

/**
 * Upgrade tests only: lets today's SQL (and so the real service and the test helpers) write into a database that is
 * still on the pre-0009 schema, where items were `accessory_variants` and the column was `variant_id`.
 * Statements are rewritten on the way in; result rows get `variant_id` renamed back to `item_id`.
 */
const toLegacySql = (sql: string): string =>
  sql.replace(/\bitems\b/g, 'accessory_variants').replace(/\bitem_id\b/g, 'variant_id');

const fromLegacyRow = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k === 'variant_id' ? 'item_id' : k, v]));

export function legacyDriver(inner: SqlDriver): SqlDriver {
  return {
    exec: (script) => inner.exec(toLegacySql(script)),
    query: async <T extends object = Record<string, SqlValue>>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<T[]> => {
      const rows = await inner.query<Record<string, unknown>>(toLegacySql(sql), params);
      return rows.map(fromLegacyRow) as T[];
    },
    batch: (statements: readonly Statement[]) =>
      inner.batch(statements.map((s) => ({ ...s, sql: toLegacySql(s.sql) }))),
  };
}
