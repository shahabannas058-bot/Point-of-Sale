export type SqlValue = string | number | bigint | Uint8Array | null;

export interface Statement {
  sql: string;
  params?: readonly SqlValue[];
}

/**
 * The only thing the service needs from a database. Implemented by sql.js (browser), better-sqlite3 (Node tests)
 * and the WebView2 bridge to C# (desktop shell).
 */
export interface SqlDriver {
  /** Runs a multi-statement script (migrations). */
  exec(script: string): Promise<void>;
  query<T extends object = Record<string, SqlValue>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]>;
  /** One atomic transaction: every statement or none. */
  batch(statements: readonly Statement[]): Promise<void>;
}
