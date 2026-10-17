import { createUuidV7Generator } from '@pos/core';
import { seededBytes, sha256Hex } from './rng';

export type RngSpec =
  { kind: 'fixed'; two: [number, number]; fill: number } | { kind: 'recorded'; calls: number[][] };

/** Shape read by UuidVectorTests (GoldenVectorTests.cs). Exactly one of now_sequence / now_constant. */
export interface UuidScenario {
  name: string;
  description: string;
  count: number;
  now_sequence?: number[];
  now_constant?: number;
  rng: RngSpec;
  expected_ids?: string[];
  expected_samples?: { index: number; id: string }[];
  expected_ids_sha256: string;
}

interface ScenarioSpec {
  name: string;
  description: string;
  count: number;
  /** Clock value for call i (index into this list), or a constant clock. */
  clock: number[] | number;
  /** 'fixed' bytes, or a seed for a deterministic stream that gets recorded call by call. */
  rng: { two: [number, number]; fill: number } | { seed: string };
  /** Write all ids (small scenarios) or only these indexes (large ones). */
  samples?: number[];
}

const T0 = 1_760_000_000_000;

/** Replays the TS generator with the C# test's random-source contract. */
export function fixedRandom(
  two: readonly [number, number],
  fill: number,
): (n: number) => Uint8Array {
  return (n: number): Uint8Array => (n === 2 ? Uint8Array.from(two) : new Uint8Array(n).fill(fill));
}

/** Runs createUuidV7Generator; `now` returns clock[i] for call i, like the C# test does. */
export function runGenerator(
  count: number,
  clock: readonly number[] | number,
  randomBytes: (n: number) => Uint8Array,
): string[] {
  let index = 0;
  const now = (): number => {
    if (typeof clock === 'number') return clock;
    const t = clock[index];
    if (t === undefined) throw new Error(`now_sequence has no entry ${String(index)}`);
    return t;
  };
  const next = createUuidV7Generator({ now, randomBytes });
  const ids: string[] = [];
  for (; index < count; index++) ids.push(next());
  return ids;
}

export const idsSha256 = (ids: readonly string[]): string => sha256Hex(ids.join('\n'));

const SPECS: readonly ScenarioSpec[] = [
  {
    name: 'fixed-rng-constant-clock',
    description: 'Fixed random bytes, one millisecond: counter starts at 0x234 and increments',
    count: 6,
    clock: T0,
    rng: { two: [0x12, 0x34], fill: 0xab },
  },
  {
    name: 'recorded-rng-advancing-clock',
    description: 'Every call in a new millisecond: randomBytes(2) + randomBytes(16) each time',
    count: 6,
    clock: [T0, T0 + 1, T0 + 2, T0 + 10, T0 + 1_000, T0 + 86_400_000],
    rng: { seed: 'uuid-advancing' },
  },
  {
    name: 'recorded-rng-same-ms-counter',
    description: 'Many ids in one millisecond: randomBytes(2) only on the first call',
    count: 8,
    clock: T0,
    rng: { seed: 'uuid-same-ms' },
  },
  {
    name: 'recorded-rng-clock-backwards',
    description: 'Clock steps back and repeats: ids keep the last ms and keep counting',
    count: 9,
    clock: [5_000, 5_000, 5_000, 4_000, 4_000, 6_000, 5_999, 6_000, 6_001],
    rng: { seed: 'uuid-backwards' },
  },
  {
    name: 'fixed-rng-counter-overflow',
    description: 'Counter starts at 0x7ff and passes 0xfff: the id borrows the next millisecond',
    count: 4_200,
    clock: T0,
    rng: { two: [0xff, 0xff], fill: 0x5c },
    samples: [0, 1, 2047, 2048, 2049, 4095, 4096, 4097, 4199],
  },
  {
    name: 'fixed-rng-overflow-then-clock-catches-up',
    description: 'Overflow into the next ms, then the real clock reaches and passes it',
    count: 2_052,
    clock: [...Array.from({ length: 2_050 }, () => T0), T0 + 1, T0 + 2],
    rng: { two: [0x07, 0xff], fill: 0x00 },
    samples: [0, 2047, 2048, 2049, 2050, 2051],
  },
  {
    name: 'fixed-rng-zero-time',
    description: 'Epoch 0 and all-ones random bytes (variant bits still forced to 10)',
    count: 3,
    clock: 0,
    rng: { two: [0x00, 0x00], fill: 0xff },
  },
];

function toScenario(spec: ScenarioSpec): UuidScenario {
  let rng: RngSpec;
  let randomBytes: (n: number) => Uint8Array;
  if ('seed' in spec.rng) {
    const source = seededBytes(spec.rng.seed);
    const calls: number[][] = [];
    randomBytes = (n) => {
      const bytes = source(n);
      calls.push(Array.from(bytes));
      return bytes;
    };
    rng = { kind: 'recorded', calls };
  } else {
    randomBytes = fixedRandom(spec.rng.two, spec.rng.fill);
    rng = { kind: 'fixed', two: spec.rng.two, fill: spec.rng.fill };
  }

  const ids = runGenerator(spec.count, spec.clock, randomBytes);
  const scenario: UuidScenario = {
    name: spec.name,
    description: spec.description,
    count: spec.count,
    ...(typeof spec.clock === 'number'
      ? { now_constant: spec.clock }
      : { now_sequence: [...spec.clock] }),
    rng,
    expected_ids_sha256: idsSha256(ids),
  };
  if (spec.samples === undefined) scenario.expected_ids = ids;
  else scenario.expected_samples = spec.samples.map((index) => ({ index, id: ids[index] ?? '' }));
  return scenario;
}

export function buildUuidScenarios(): UuidScenario[] {
  return SPECS.map(toScenario);
}
