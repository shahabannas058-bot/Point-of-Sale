import type { OutboxEntityType, OutboxOp } from '@pos/shared';
import type { SqlValue } from '../types';
import type { WriteBatch } from './batch';

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const columns = (rec: object): [string, SqlValue][] =>
  Object.entries(rec).map(([k, v]) => [snake(k), v as SqlValue]);

/** INSERT of a camelCase record (column = snake_case key) plus its outbox row (payload = the same record). */
export function insertRec<T extends { id: string }>(
  b: WriteBatch,
  table: string,
  entityType: OutboxEntityType,
  rec: T,
): void {
  const cols = columns(rec);
  b.add(
    `INSERT INTO ${table} (${cols.map(([c]) => c).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map(([, v]) => v),
  ).emit(entityType, rec.id, 'insert' satisfies OutboxOp, rec);
}

/**
 * UPDATE of the listed camelCase fields of `rec` by id, plus an outbox row carrying the WHOLE record
 * (every outbox payload is the full contract entity, so a second device can upsert it).
 */
export function updateRec<T extends { id: string }>(
  b: WriteBatch,
  table: string,
  entityType: OutboxEntityType,
  rec: T,
  fields: readonly string[],
): void {
  const all = new Map(columns(rec));
  const set = fields.map((f) => snake(f));
  b.add(`UPDATE ${table} SET ${set.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...set.map((c) => all.get(c) ?? null),
    rec.id,
  ]).emit(entityType, rec.id, 'update' satisfies OutboxOp, rec);
}
