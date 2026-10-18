import { createUuidV7Generator } from '@pos/core';
import type { PosService } from '@pos/shared';
import { createPosService } from './create-service';
import type { ServiceDeps } from './deps';

export interface SeedSummary {
  phones: number;
  accessories: number;
  customers: number;
  suppliers: number;
  /** Invoices created (sales plus the one sample return). */
  sales: number;
}

/** Rupees (a fraction such as 285.5 is fine) to integer paisa. */
export const rs = (rupees: number): number => Math.round(rupees * 100);
const SEED_EPOCH_MS = Date.UTC(2026, 0, 1);

/** Deterministic byte stream (xorshift32) so demo ids are identical after every reset. */
function xorshiftBytes(seed: number): (n: number) => Uint8Array {
  let s = seed >>> 0 || 1;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      s = (s ^ (s << 13)) >>> 0;
      s = (s ^ (s >>> 17)) >>> 0;
      s = (s ^ (s << 5)) >>> 0;
      out[i] = s & 0xff;
    }
    return out;
  };
}

export const ean13 = (body12: string): string => {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(body12[i]) * (i % 2 === 0 ? 1 : 3);
  return `${body12}${(10 - (sum % 10)) % 10}`;
};

/**
 * A service instance for seeding: stepping clock (10 s per call, never past "now") and a deterministic id generator.
 * Goes through the REAL service so outbox rows and the hash chain are exercised.
 */
export function createSeedService(deps: ServiceDeps): PosService {
  const now0 = Date.now();
  const base = now0 - 2 * 60 * 60 * 1000;
  let step = 0;
  const clock = (): number => Math.min(base + step++ * 10_000, now0);
  return createPosService({
    driver: deps.driver,
    assertCanSell: deps.assertCanSell,
    randomBytes: deps.randomBytes,
    pinIterations: deps.pinIterations,
    clock,
    newId: createUuidV7Generator({
      now: () => SEED_EPOCH_MS,
      randomBytes: xorshiftBytes(0x5eed1234),
    }),
  });
}
