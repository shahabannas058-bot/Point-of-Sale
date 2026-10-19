import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '@pos/core';
import { consoleSink, setLogSink, type LogEntry } from '@pos/shared';
import { mapError } from '../../src/service/errors';

let seen: LogEntry[] = [];
beforeEach(() => {
  seen = [];
  setLogSink((e) => seen.push(e));
});
afterEach(() => setLogSink(consoleSink));

describe('mapError logging', () => {
  it('logs one error entry with the original message, stack and cause chain when mapping to INTERNAL', () => {
    // Arrange
    const root = new Error('disk I/O error');
    const thrown = new Error('SQLITE_IOERR: write failed', { cause: root });

    // Act
    const mapped = mapError(thrown);

    // Assert
    expect(mapped.code).toBe('INTERNAL');
    expect(mapped.message).toBe('Unexpected internal error'); // the user still sees the generic text
    const errors = seen.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    const ctx = errors[0]!.ctx as {
      code: string;
      error: { message: string; stack?: string; cause?: { message: string } };
    };
    expect(ctx.code).toBe('INTERNAL');
    expect(ctx.error.message).toBe('SQLITE_IOERR: write failed');
    expect(ctx.error.stack).toContain('SQLITE_IOERR');
    expect(ctx.error.cause?.message).toBe('disk I/O error');
  });

  it('logs DB_CONSTRAINT mappings with the raw constraint text', () => {
    mapError(new Error('CHECK constraint failed: qty_positive'));
    const errors = seen.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0]!.ctx as { code: string }).code).toBe('DB_CONSTRAINT');
    expect(JSON.stringify(errors[0]!.ctx)).toContain('CHECK constraint failed: qty_positive');
  });

  it('logs the internal DomainError codes that are hidden behind INTERNAL', () => {
    mapError(new DomainError('CANONICAL_INVALID', 'canonical json mismatch'));
    expect(seen.filter((e) => e.level === 'error')).toHaveLength(1);
    expect(JSON.stringify(seen[0]!.ctx)).toContain('canonical json mismatch');
  });

  it('does not log expected, user-facing mappings', () => {
    mapError(new Error('UNIQUE constraint failed: items.barcode'));
    mapError(new Error('khata requires a sale with a customer'));
    mapError(new DomainError('STOCK_INSUFFICIENT', 'short'));
    expect(seen).toHaveLength(0);
  });

  it('never lets a pin, hash or token in the thrown error reach the log', () => {
    const e = Object.assign(new Error('weird failure'), {
      details: { pin: '1234', pinHash: 'deadbeef', approvalToken: 'tok', field: 'name' },
    });
    mapError(e);
    const text = JSON.stringify(seen);
    expect(text).not.toContain('1234');
    expect(text).not.toContain('deadbeef');
    expect(text).not.toContain('tok"');
    expect(text).toContain('"field":"name"');
  });
});
