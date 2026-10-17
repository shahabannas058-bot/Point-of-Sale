import { createHash } from 'node:crypto';

const SHA256_BYTES = 32;

/** Deterministic byte source: call k returns the first n bytes of sha256(`${seed}:${k}`). */
export function seededBytes(seed: string): (n: number) => Uint8Array {
  let call = 0;
  return (n: number): Uint8Array => {
    if (!Number.isInteger(n) || n < 0 || n > SHA256_BYTES)
      throw new Error(`seededBytes supports 0..${String(SHA256_BYTES)} bytes, got ${String(n)}`);
    const digest = createHash('sha256')
      .update(`${seed}:${String(call)}`)
      .digest();
    call += 1;
    return Uint8Array.from(digest.subarray(0, n));
  };
}

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
