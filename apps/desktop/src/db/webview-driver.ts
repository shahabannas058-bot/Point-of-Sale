import type { SqlDriver, SqlValue, Statement } from '@pos/db';
import { call } from '../native/webview-bridge';

/**
 * SqlDriver over the native SQLite file: the same contract as the sql.js and Node drivers, so the TypeScript
 * PosService (inventory, khata, reports, ...) keeps working unchanged while the database itself lives in C#.
 * C# has already created and migrated pos.db before the page loads, so do NOT call migrate() in this mode.
 *
 * NOTE: db.query / db.exec / db.batch expose raw SQL to the page. That is acceptable only while the page is our own
 * bundle served from the app's virtual host (the shell refuses to navigate anywhere else and DevTools are off in
 * release). As services move to C#, replace these with typed methods like `checkout.commit` and delete them.
 */
export const createWebViewDriver = (): SqlDriver => ({
  exec: (script) => call<void>('db.exec', { sql: script }),
  query: <T extends object = Record<string, SqlValue>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ) => call<T[]>('db.query', { sql, params }),
  batch: (statements: readonly Statement[]) =>
    call<void>('db.batch', {
      statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
    }),
});
