import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  computeInvoiceHash,
  createUuidV7Generator,
  invoiceHashPayload,
  sealInvoice,
  type UnsealedInvoice,
} from '../src';

/**
 * Drift guard for /testdata (written by `npm run vectors`, replayed by the .NET tests): the committed expected
 * values must still be what the TypeScript code produces. If this fails, either the TS changed on purpose
 * (re-run `npm run vectors` and update the C# port) or the vectors were edited by hand.
 */

const load = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../../../testdata/${file}`, import.meta.url), 'utf8')) as T;

interface InvoiceVector {
  name: string;
  previous_hash: string;
  unsealed_data: UnsealedInvoice;
  canonical: string;
  expected_hash: string;
}

type Rng =
  { kind: 'fixed'; two: [number, number]; fill: number } | { kind: 'recorded'; calls: number[][] };

interface UuidScenario {
  name: string;
  count: number;
  now_sequence?: number[];
  now_constant?: number;
  rng: Rng;
  expected_ids?: string[];
  expected_samples?: { index: number; id: string }[];
  expected_ids_sha256: string;
}

const invoices = load<{ vectors: InvoiceVector[] }>('invoice-vectors.json').vectors;
const scenarios = load<{ scenarios: UuidScenario[] }>('uuid-vectors.json').scenarios;

describe('invoice-vectors.json', () => {
  it('has enough vectors with unique names', () => {
    expect(invoices.length).toBeGreaterThanOrEqual(5);
    expect(new Set(invoices.map((v) => v.name)).size).toBe(invoices.length);
  });

  it.each(invoices.map((v) => [v.name, v] as const))('%s: canonical and hash match', (_, v) => {
    expect(invoiceHashPayload(v.unsealed_data)).toBe(v.canonical);
    expect(computeInvoiceHash(v.previous_hash, v.unsealed_data)).toBe(v.expected_hash);
  });

  it('forms one chain from genesis', () => {
    let prev = GENESIS_HASH;
    for (const v of invoices) {
      expect(v.previous_hash).toBe(prev);
      prev = sealInvoice(v.previous_hash, v.unsealed_data).hash;
      expect(prev).toBe(v.expected_hash);
    }
  });
});

/** Replays a scenario exactly the way UuidVectorTests (C#) does. */
function replay(s: UuidScenario): string[] {
  const { rng } = s;
  let index = 0;
  let call = 0;
  const randomBytes = (n: number): Uint8Array => {
    if (rng.kind === 'fixed')
      return n === 2 ? Uint8Array.from(rng.two) : new Uint8Array(n).fill(rng.fill);
    const recorded = rng.calls[call++];
    expect(recorded?.length).toBe(n);
    return Uint8Array.from(recorded ?? []);
  };
  const now = (): number => (s.now_sequence ? s.now_sequence[index]! : s.now_constant!);
  const next = createUuidV7Generator({ now, randomBytes });
  const ids: string[] = [];
  for (; index < s.count; index++) ids.push(next());
  if (rng.kind === 'recorded') expect(call).toBe(rng.calls.length);
  return ids;
}

describe('uuid-vectors.json', () => {
  it.each(scenarios.map((s) => [s.name, s] as const))('%s: ids replay bit for bit', (_, s) => {
    expect((s.now_sequence === undefined) !== (s.now_constant === undefined)).toBe(true);
    const ids = replay(s);
    const sha = createHash('sha256').update(ids.join('\n'), 'utf8').digest('hex');
    expect(sha).toBe(s.expected_ids_sha256);
    if (s.expected_ids) expect(ids).toEqual(s.expected_ids);
    for (const sample of s.expected_samples ?? []) expect(ids[sample.index]).toBe(sample.id);
    expect(s.expected_ids ?? s.expected_samples).toBeDefined();
  });
});
