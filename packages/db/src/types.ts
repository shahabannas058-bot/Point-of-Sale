export type SqlValue = string | number | null;

export interface Statement {
  readonly sql: string;
  readonly params?: readonly SqlValue[];
}

/**
 * Async on purpose: in Tauri every call crosses IPC into Rust. Node/better-sqlite3 just wraps sync calls.
 * `batch` is ONE atomic transaction. `exec` runs a multi-statement script (migrations).
 */
export interface SqlDriver {
  exec(script: string): Promise<void>;
  query<T extends object = Record<string, SqlValue>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]>;
  batch(statements: readonly Statement[]): Promise<void>;
}
