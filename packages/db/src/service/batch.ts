import type { OutboxEntityType, OutboxOp } from '@pos/shared';
import type { SqlDriver, SqlValue, Statement } from '../types';

/**
 * Collects the statements of ONE business operation. Every `emit` appends its outbox INSERT to the same
 * list, so data and outbox land in a single `driver.batch` (one SQLite transaction).
 */
export class WriteBatch {
  private readonly statements: Statement[] = [];

  constructor(
    private readonly newId: () => string,
    private readonly at: number,
  ) {}

  add(sql: string, params: readonly SqlValue[] = []): this {
    this.statements.push({ sql, params });
    return this;
  }

  /** payload = the camelCase contract entity (a full Invoice for 'sale'). */
  emit(entityType: OutboxEntityType, entityId: string, op: OutboxOp, payload: unknown): this {
    return this.add(
      'INSERT INTO outbox (id, entity_type, entity_id, op, payload, created_at) VALUES (?,?,?,?,?,?)',
      [this.newId(), entityType, entityId, op, JSON.stringify(payload), this.at],
    );
  }

  get size(): number {
    return this.statements.length;
  }

  async commit(driver: SqlDriver): Promise<void> {
    await driver.batch(this.statements);
  }
}
