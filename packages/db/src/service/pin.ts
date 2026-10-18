import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ServiceError } from '@pos/shared';

/*
 * MVP-grade PIN storage. PBKDF2-HMAC-SHA256 with a per-user random salt, stored as
 *   pbkdf2$sha256$<iterations>$<saltHex>$<hashHex>
 * A 4-digit PIN has only 10^4 values, so anyone who copies the database file can brute-force
 * it offline in seconds no matter how the hash is built. The real protection is OS/disk access
 * control, and later the Rust side. Do not mistake this for strong credential storage.
 */
const MAX_ITERATIONS = 1_000_000;

/** A PIN is exactly this many digits; the login screen relies on it to sign in as soon as the last digit is typed. */
export const PIN_LENGTH = 4;

export function validatePinFormat(pin: unknown, field = 'pin'): string {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin))
    throw new ServiceError('VALIDATION', `PIN must be exactly ${String(PIN_LENGTH)} digits`, {
      field,
    });
  return pin;
}

export async function hashPin(
  pin: string,
  iterations: number,
  randomBytes: (n: number) => Uint8Array,
): Promise<string> {
  const salt = randomBytes(16);
  const dk = await pbkdf2Async(sha256, pin, salt, { c: iterations, dkLen: 32 });
  return `pbkdf2$sha256$${iterations}$${bytesToHex(salt)}$${bytesToHex(dk)}`;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = hexToBytes(parts[3] ?? '');
    expected = hexToBytes(parts[4] ?? '');
  } catch {
    return false;
  }
  const dk = await pbkdf2Async(sha256, pin, salt, { c: iterations, dkLen: expected.length || 32 });
  return constantTimeEqual(dk, expected);
}
