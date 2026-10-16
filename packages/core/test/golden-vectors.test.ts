import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, type UnsealedInvoice } from '@pos/shared';
import {
  canonicalize,
  computeInvoiceHash,
  createUuidV7Generator,
  invoiceHashPayload,
} from '@pos/core';

/**
 * Guards the files in /testdata that the C# port is tested against. If one of these fails you changed
 * the hash format or a generator: regenerate with `npm run vectors`, then update the C# code to match.
 */
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../../testdata/${name}`, import.meta.url), 'utf8')) as T;

interface InvoiceVector {
  name: string;
  previous_hash: string;
  unsealed_data: UnsealedInvoice;
  canonical: string;
  expected_hash: string;
}

describe('golden invoice vectors (shared with C#)', () => {
  const { vectors } = read<{ vectors: InvoiceVector[] }>('invoice-vectors.json');

  it('has the expected edge cases', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
    expect(vectors[0]?.previous_hash).toBe(GENESIS_HASH);
  });

  it.each(vectors.map((v) => [v.name, v] as const))(
    '%s: canonical form and hash are stable',
    (_n, v) => {
      expect(canonicalize(invoiceHashPayload(v.unsealed_data))).toBe(v.canonical);
      expect(computeInvoiceHash(v.previous_hash, v.unsealed_data)).toBe(v.expected_hash);
    },
  );

  it('vectors form one chain', () => {
    vectors.forEach((v, i) => {
      expect(v.previous_hash).toBe(i === 0 ? GENESIS_HASH : vectors[i - 1]?.expected_hash);
    });
  });
});

describe('golden uuid v7 vectors (shared with C#)', () => {
  interface Scenario {
    now_sequence?: number[];
    now_constant?: number;
    count: number;
    rng:
      | { kind: 'replay'; calls: number[][] }
      | { kind: 'fixed'; two: [number, number]; fill: number };
    expected_ids?: string[];
  }
  const { scenarios } = read<{ scenarios: (Scenario & { name: string })[] }>('uuid-vectors.json');

  it.each(scenarios.filter((s) => s.expected_ids).map((s) => [s.name, s] as const))(
    '%s: replay reproduces the ids',
    (_n, s) => {
      let index = 0;
      let call = 0;
      const gen = createUuidV7Generator({
        now: () => s.now_sequence?.[index] ?? s.now_constant ?? 0,
        randomBytes: (n) => {
          if (s.rng.kind === 'fixed')
            return n === 2 ? Uint8Array.from(s.rng.two) : new Uint8Array(n).fill(s.rng.fill);
          const recorded = s.rng.calls[call++];
          expect(recorded?.length).toBe(n);
          return Uint8Array.from(recorded ?? []);
        },
      });
      const ids: string[] = [];
      for (; index < s.count; index += 1) ids.push(gen());
      expect(ids).toEqual(s.expected_ids);
    },
  );
});
