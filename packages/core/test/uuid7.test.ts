import { describe, expect, it } from 'vitest';
import { createUuidV7Generator, isUuidV7, uuidV7Timestamp, uuidv7 } from '@pos/core';
import { UuidV7Schema } from '@pos/shared';
import { seededRandomBytes } from './fixtures';

const NOW = 1_760_000_000_000;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('format', () => {
  it('matches the UUID v7 pattern with version 7 and RFC variant', () => {
    const gen = createUuidV7Generator({ now: () => NOW, randomBytes: seededRandomBytes(1) });
    for (let i = 0; i < 200; i++) {
      const id = gen();
      expect(id).toMatch(UUID_V7_RE);
      expect(id[14]).toBe('7');
      expect('89ab').toContain(id[19]!);
      expect(isUuidV7(id)).toBe(true);
      expect(UuidV7Schema.safeParse(id).success).toBe(true);
    }
  });

  it('rejects version 4 and uppercase ids', () => {
    expect(isUuidV7('3f2b8c1e-9a4d-4e6b-8c1d-2f3a4b5c6d7e')).toBe(false);
    const gen = createUuidV7Generator({ now: () => NOW, randomBytes: seededRandomBytes(1) });
    expect(isUuidV7(gen().toUpperCase())).toBe(false);
    expect(isUuidV7('not-a-uuid')).toBe(false);
    expect(isUuidV7('')).toBe(false);
  });

  it('works with the default (crypto) generator', () => {
    expect(isUuidV7(uuidv7())).toBe(true);
  });
});

describe('timestamp', () => {
  it('embeds the millisecond clock in the first 48 bits', () => {
    const gen = createUuidV7Generator({ now: () => NOW, randomBytes: seededRandomBytes(2) });
    const id = gen();
    expect(uuidV7Timestamp(id)).toBe(NOW);
    const hex = NOW.toString(16).padStart(12, '0');
    expect(id.slice(0, 8) + id.slice(9, 13)).toBe(hex);
  });

  it('floors fractional clock readings', () => {
    const gen = createUuidV7Generator({ now: () => NOW + 0.9, randomBytes: seededRandomBytes(2) });
    expect(uuidV7Timestamp(gen())).toBe(NOW);
  });
});

describe('monotonicity', () => {
  it('is strictly increasing within one millisecond, spilling into the next ms past 4096 ids', () => {
    const gen = createUuidV7Generator({ now: () => NOW, randomBytes: seededRandomBytes(3) });
    const ids = Array.from({ length: 5000 }, () => gen());
    expect(new Set(ids).size).toBe(5000);
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    // more ids than one millisecond can hold: the embedded timestamp must have advanced
    expect(uuidV7Timestamp(ids.at(-1)!)).toBeGreaterThan(NOW);
    expect(uuidV7Timestamp(ids.at(-1)!)).toBeLessThanOrEqual(NOW + 2);
  });

  it('is strictly increasing across 10,000 ids with an advancing clock', () => {
    let t = NOW;
    const gen = createUuidV7Generator({
      now: () => {
        t += 1;
        return t;
      },
      randomBytes: seededRandomBytes(4),
    });
    const ids = Array.from({ length: 10_000 }, () => gen());
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
  });

  it('stays strictly increasing when the clock runs backwards', () => {
    let t = NOW + 100_000;
    const gen = createUuidV7Generator({
      now: () => {
        t -= 1;
        return t;
      },
      randomBytes: seededRandomBytes(5),
    });
    const ids = Array.from({ length: 10_000 }, () => gen());
    expect(new Set(ids).size).toBe(10_000);
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
  });
});

describe('determinism and uniqueness', () => {
  it('identical injected clock and randomness give identical output', () => {
    const make = () => createUuidV7Generator({ now: () => NOW, randomBytes: seededRandomBytes(9) });
    const a = make();
    const b = make();
    const idsA = Array.from({ length: 50 }, () => a());
    const idsB = Array.from({ length: 50 }, () => b());
    expect(idsA).toEqual(idsB);
  });

  it('different seeds give different ids', () => {
    const a = createUuidV7Generator({ now: () => NOW, randomBytes: seededRandomBytes(1) });
    const b = createUuidV7Generator({ now: () => NOW, randomBytes: seededRandomBytes(2) });
    expect(a()).not.toBe(b());
  });

  it('1,000 ids from the default generator are unique', () => {
    const gen = createUuidV7Generator();
    expect(new Set(Array.from({ length: 1000 }, () => gen())).size).toBe(1000);
  });
});
