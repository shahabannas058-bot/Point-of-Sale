import { UuidV7Schema } from '@pos/shared';

export type RandomBytes = (length: number) => Uint8Array;
export interface UuidV7Options {
  now?: () => number;
  randomBytes?: RandomBytes;
}

const defaultRandomBytes: RandomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * RFC 9562 UUID v7: 48-bit ms timestamp | ver 7 | 12-bit counter | variant 10 | 62 random bits.
 * Strictly monotonic per generator, even within one millisecond or if the clock steps backwards.
 */
export function createUuidV7Generator(options: UuidV7Options = {}): () => string {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  let lastMs = -1;
  let counter = 0;
  return () => {
    const nowMs = Math.floor(now());
    if (nowMs > lastMs) {
      lastMs = nowMs;
      const r = randomBytes(2);
      counter = (((r[0] ?? 0) << 8) | (r[1] ?? 0)) & 0x7ff; // start low: 2048 ids of headroom per ms
    } else {
      counter += 1;
      if (counter > 0xfff) {
        lastMs += 1;
        counter = 0;
      }
    }
    const b = Uint8Array.from(randomBytes(16));
    b[0] = Math.floor(lastMs / 2 ** 40) & 0xff;
    b[1] = Math.floor(lastMs / 2 ** 32) & 0xff;
    b[2] = Math.floor(lastMs / 2 ** 24) & 0xff;
    b[3] = Math.floor(lastMs / 2 ** 16) & 0xff;
    b[4] = Math.floor(lastMs / 2 ** 8) & 0xff;
    b[5] = lastMs & 0xff;
    b[6] = 0x70 | (counter >> 8);
    b[7] = counter & 0xff;
    b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}

export const uuidv7 = createUuidV7Generator();
export const isUuidV7 = (id: string): boolean => UuidV7Schema.safeParse(id).success;
export const uuidV7Timestamp = (id: string): number =>
  Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
