import type { Id } from '@pos/shared';

export interface UuidV7Options {
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
}

const defaultRandom = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * RFC 9562 UUID v7: 48-bit ms | ver 7 | 12-bit counter | variant 10 | 62 random bits.
 * Strictly monotonic per generator, even within one millisecond or when the clock steps back.
 * Call order (now, randomBytes(2) only when the ms advanced, randomBytes(16)) matches the C# port.
 */
export function createUuidV7Generator(opts: UuidV7Options = {}): () => Id {
  const now = opts.now ?? Date.now;
  const randomBytes = opts.randomBytes ?? defaultRandom;
  let lastMs = -1;
  let counter = 0;

  return () => {
    const ms = now();
    if (ms > lastMs) {
      lastMs = ms;
      const r = randomBytes(2);
      counter = (((r[0] ?? 0) << 8) | (r[1] ?? 0)) & 0x7ff; // start low: 2048 ids of headroom per ms
    } else {
      counter += 1;
      if (counter > 0xfff) {
        lastMs += 1;
        counter = 0;
      }
    }
    const random = randomBytes(16);
    if (random.length !== 16) throw new Error('randomBytes(16) must return 16 bytes');
    const b = Uint8Array.from(random);
    const msBig = BigInt(lastMs);
    for (let i = 0; i < 6; i++) b[i] = Number((msBig >> BigInt(8 * (5 - i))) & 0xffn);
    b[6] = 0x70 | (counter >> 8);
    b[7] = counter & 0xff;
    b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
    const h = hex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}

/** Shared default generator. */
export const uuidv7: () => Id = createUuidV7Generator();

/** Epoch milliseconds stored in the first 48 bits. */
export const uuidV7Timestamp = (id: Id): number => parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
