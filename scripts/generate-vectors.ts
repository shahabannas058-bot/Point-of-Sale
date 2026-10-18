/* eslint-disable no-console -- CLI script, console is its output */
/* Golden vectors for the C# port. Run: npm run vectors   (writes testdata/*.json)
   TypeScript is the reference implementation: the C# code must reproduce every `expected_*` value
   byte for byte. Output is deterministic (seeded ids, fixed clock), so re-running changes nothing. */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GENESIS_HASH,
  InvoiceSchema,
  ServiceError,
  type Invoice,
  type UnsealedInvoice,
} from '@pos/shared';
import {
  assertPaymentsMatchTotal,
  canonicalize,
  computeInvoiceHash,
  createUuidV7Generator,
  formatInvoiceNo,
  invoiceHashPayload,
  isUuidV7,
  paisa,
  saleTotals,
  sealInvoice,
  verifyChain,
} from '@pos/core';
import { intIn, money, optIntIn, optText } from '../packages/db/src/service/errors';
import { checksum } from '../packages/db/src/migrate';
import { loadMigrationsFromDir } from '../packages/db/src/node';

const OUT = fileURLToPath(new URL('../testdata/', import.meta.url));
const BASE_MS = 1_760_000_000_000;

/** ASCII-only JSON: every char >= U+007F becomes \uXXXX, so the file survives any editor, encoding or normalisation. */
const asciiJson = (v: unknown): string =>
  JSON.stringify(v, null, 2).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  ) + '\n';

/** Small deterministic PRNG (mulberry32), same as the test fixtures. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =====================================================================================
// 1. Invoice vectors
// =====================================================================================
const rand = mulberry32(2026);
let clockMs = BASE_MS;
const newId = createUuidV7Generator({
  now: () => clockMs++,
  randomBytes: (n) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256)),
});
const ids = {
  device: newId(),
  branch: newId(),
  cashier: newId(),
  customer: newId(),
  product: newId(),
  phone: newId(),
  variant: newId(),
};

interface LineIn {
  phoneUnitId: string | null;
  variantId: string | null;
  description: string;
  quantity: number;
  /** Omitted = 1 (pieces). Only written into the data of hashVersion 2 invoices. */
  unitScale?: 1 | 1000;
  unitPrice: number;
  costPrice: number;
  discountAmount: number;
}
interface PayIn {
  method: string;
  amount: number;
  reference: string | null;
}
interface Spec {
  name: string;
  kind: 'sale' | 'return' | 'void';
  /** Default 1. Version 2 puts unitScale into every line's hashed data. */
  hashVersion?: 1 | 2;
  /** An invoice id, 'FIRST' (the first invoice) or 'NAME:<spec name>'. */
  originalSaleId?: string | null;
  customerId: string | null;
  note: string | null;
  invoiceDiscount: number;
  lines: LineIn[];
  payments: PayIn[];
  /** Reverse the array order of lines and payments: the hash must not depend on it. */
  scramble?: boolean;
}

const accessory = (
  description: string,
  quantity: number,
  unitPrice: number,
  discountAmount = 0,
): LineIn => ({
  phoneUnitId: null,
  variantId: ids.variant,
  description,
  quantity,
  unitPrice,
  costPrice: Math.floor(unitPrice * 0.6),
  discountAmount,
});
const phone = (
  description: string,
  quantity: number,
  unitPrice: number,
  discountAmount = 0,
): LineIn => ({
  phoneUnitId: ids.phone,
  variantId: null,
  description,
  quantity,
  unitPrice,
  costPrice: Math.floor(unitPrice * 0.75),
  discountAmount,
});

/** Loose goods: quantity in grams, price per kg (unitScale 1000). */
const weighted = (
  description: string,
  grams: number,
  pricePerKg: number,
  discountAmount = 0,
): LineIn => ({
  phoneUnitId: null,
  variantId: ids.variant,
  description,
  quantity: grams,
  unitScale: 1000,
  unitPrice: pricePerKg,
  costPrice: Math.floor(pricePerKg * 0.8),
  discountAmount,
});

let seq = 0;
function buildUnsealed(s: Spec): UnsealedInvoice {
  seq += 1;
  const id = newId();
  const createdAt = BASE_MS + seq * 60_000;
  const version = s.hashVersion ?? 1;
  const totals = saleTotals(
    s.lines.map((l) => ({
      quantity: l.quantity,
      unitScale: l.unitScale ?? 1,
      unitPrice: paisa(l.unitPrice),
      discountAmount: paisa(l.discountAmount),
    })),
    paisa(s.invoiceDiscount),
  );
  assertPaymentsMatchTotal(
    totals.total,
    s.payments.map((p) => ({ method: p.method as 'cash', amount: paisa(p.amount) })),
  );
  const lines = s.lines.map((l, i) => ({
    id: newId(),
    saleId: id,
    lineNo: i + 1,
    productId: ids.product,
    ...l,
    ...(version >= 2 ? { unitScale: l.unitScale ?? 1 } : {}),
    lineTotal: totals.lineTotals[i],
    createdAt,
  }));
  const payments = s.payments.map((p) => ({ id: newId(), saleId: id, ...p, createdAt }));
  return {
    id,
    deviceId: ids.device,
    seq,
    invoiceNo: formatInvoiceNo('A', seq),
    kind: s.kind,
    originalSaleId: s.originalSaleId ?? null,
    branchId: ids.branch,
    customerId: s.customerId,
    cashierId: ids.cashier,
    subtotal: totals.subtotal,
    discountTotal: s.invoiceDiscount,
    total: totals.total,
    note: s.note,
    createdAt,
    hashVersion: version,
    lines: s.scramble ? [...lines].reverse() : lines,
    payments: s.scramble ? [...payments].reverse() : payments,
  } as unknown as UnsealedInvoice;
}

const specs: Spec[] = [
  {
    name: 'khata-split-basic',
    kind: 'sale',
    customerId: ids.customer,
    note: null,
    invoiceDiscount: 0,
    lines: [
      accessory('Fast Charger 25W', 2, 50_000),
      phone('Galaxy A55 8/256 · IMEI 356938035643809', 1, 199_950, 19_995),
    ],
    payments: [
      { method: 'cash', amount: 179_955, reference: null },
      { method: 'khata', amount: 100_000, reference: null },
    ],
  },
  {
    name: 'urdu-text',
    kind: 'sale',
    customerId: ids.customer,
    note: 'نقد ادائیگی — شکریہ ✓',
    invoiceDiscount: 0,
    lines: [phone('سیمسنگ گلیکسی A55 (نیلا, 8/256GB) · IMEI 356938035643809', 1, 8_500_000)],
    payments: [{ method: 'cash', amount: 8_500_000, reference: null }],
  },
  {
    name: 'special-characters',
    kind: 'sale',
    customerId: ids.customer,
    note: 'line1\nline2\ttab \u0001 ctrl, emoji 😀, DEL \u007f, LS  , </script> & "q" \\ /',
    invoiceDiscount: 100,
    lines: [accessory('Cable "USB-C" \\ 1m / <fast> & \'strong\'', 1, 120_000)],
    payments: [{ method: 'cash', amount: 119_900, reference: 'REF "A\\B"' }],
  },
  {
    name: 'null-customer-cash',
    kind: 'sale',
    customerId: null,
    note: null,
    invoiceDiscount: 0,
    lines: [accessory('Screen Guard', 3, 1_250, 50)],
    payments: [{ method: 'cash', amount: 3_700, reference: null }],
  },
  {
    name: 'return-negative-discount',
    kind: 'return',
    originalSaleId: 'FIRST', // replaced below with the id of the first invoice
    customerId: ids.customer,
    note: 'wapsi — screen crack',
    invoiceDiscount: -500,
    lines: [phone('Galaxy A55 8/256 · IMEI 356938035643809', -1, 199_950, -19_995)],
    payments: [
      { method: 'cash', amount: -79_455, reference: null },
      { method: 'khata', amount: -100_000, reference: null },
    ],
  },
  {
    name: 'three-way-split-scrambled',
    kind: 'sale',
    customerId: ids.customer,
    note: null,
    invoiceDiscount: 2_500,
    scramble: true,
    lines: [accessory('Back Cover', 1, 300_000), accessory('Earbuds', 1, 150_000)],
    payments: [
      { method: 'cash', amount: 200_000, reference: null },
      { method: 'jazzcash', amount: 150_000, reference: 'TXN "9"\\77' },
      { method: 'khata', amount: 97_500, reference: null },
    ],
  },
  {
    name: 'large-amounts',
    kind: 'sale',
    customerId: null,
    note: null,
    invoiceDiscount: 0,
    lines: [accessory('Gold-plated charger', 2, 4_000_000_000_000_000)],
    payments: [{ method: 'cash', amount: 8_000_000_000_000_000, reference: null }],
  },
  // ---- hashVersion 2 (ADR-0008): every line carries unitScale in the hashed data ----
  {
    name: 'v2-piece-scale-one',
    kind: 'sale',
    hashVersion: 2,
    customerId: null,
    note: null,
    invoiceDiscount: 0,
    lines: [accessory('Pen', 3, 2_500)],
    payments: [{ method: 'cash', amount: 7_500, reference: null }],
  },
  {
    // 1250 g x Rs 285.50/kg = 35,687.5 paisa -> rounds half away from zero to 35,688
    name: 'v2-weighted-rounding-half-up',
    kind: 'sale',
    hashVersion: 2,
    customerId: ids.customer,
    note: 'kiryana: chini aur atta',
    invoiceDiscount: 0,
    lines: [weighted('Chini (sugar) loose', 1_250, 28_550), weighted('Atta loose', 333, 12_000)],
    payments: [
      { method: 'cash', amount: 30_000, reference: null },
      { method: 'khata', amount: 9_684, reference: null },
    ],
  },
  {
    // the mirror image: -35,687.5 rounds half away from zero to -35,688
    name: 'v2-weighted-return-rounding',
    kind: 'return',
    hashVersion: 2,
    originalSaleId: 'NAME:v2-weighted-rounding-half-up',
    customerId: ids.customer,
    note: 'wapsi: chini',
    invoiceDiscount: 0,
    lines: [weighted('Chini (sugar) loose', -1_250, 28_550)],
    payments: [{ method: 'khata', amount: -35_688, reference: null }],
  },
  {
    name: 'v2-weighted-line-discount',
    kind: 'sale',
    hashVersion: 2,
    customerId: null,
    note: null,
    invoiceDiscount: 0,
    lines: [weighted('Basmati chawal loose', 2_500, 41_000, 1_025)],
    payments: [{ method: 'cash', amount: 101_475, reference: null }],
  },
];

interface InvoiceVector {
  name: string;
  previous_hash: string;
  unsealed_data: UnsealedInvoice;
  canonical: string;
  expected_hash: string;
}

const vectors: InvoiceVector[] = [];
const chain: Invoice[] = [];
const idByName = new Map<string, string>();
let prev: string = GENESIS_HASH;
for (const spec of specs) {
  const first = chain[0];
  if (spec.originalSaleId === 'FIRST' && first) spec.originalSaleId = first.id;
  if (spec.originalSaleId?.startsWith('NAME:')) {
    const target = idByName.get(spec.originalSaleId.slice(5));
    if (target === undefined) throw new Error(`unknown original invoice in ${spec.name}`);
    spec.originalSaleId = target;
  }
  const unsealed = buildUnsealed(spec);
  idByName.set(spec.name, unsealed.id);
  const sealed = InvoiceSchema.parse(sealInvoice(prev, unsealed)); // TS itself must accept it
  vectors.push({
    name: spec.name,
    previous_hash: prev,
    unsealed_data: unsealed,
    canonical: canonicalize(invoiceHashPayload(unsealed)),
    expected_hash: sealed.hash,
  });
  chain.push(sealed);
  prev = sealed.hash;
}

const chainCheck = verifyChain(chain);
if (!chainCheck.ok) throw new Error(`generated chain does not verify: ${chainCheck.reason}`);

// =====================================================================================
// 2. Helper vectors: intIn / optIntIn / money / optText, recorded from the real TS code
// =====================================================================================
interface Args {
  v?: unknown; // omitted from the JSON when undefined (== "field not sent")
  field: string;
  min?: number;
  max?: number;
  allowZero?: boolean;
  allowNegative?: boolean;
}
type Expect =
  { ok: true; value: unknown } | { ok: false; code: string; field: string | null; message: string };

function call(fn: string, a: Args): unknown {
  switch (fn) {
    case 'intIn':
      return intIn(a.v, a.field, a.min ?? 0, a.max ?? 0);
    case 'optIntIn':
      return optIntIn(a.v, a.field, a.min ?? 0, a.max ?? 0);
    case 'money': {
      const opts: { allowZero?: boolean; allowNegative?: boolean } = {};
      if (a.allowZero !== undefined) opts.allowZero = a.allowZero;
      if (a.allowNegative !== undefined) opts.allowNegative = a.allowNegative;
      return money(a.v, a.field, opts);
    }
    case 'optText':
      return optText(a.v, a.field, a.max ?? 0);
    default:
      throw new Error(`unknown helper ${fn}`);
  }
}

function record(fn: string, a: Args): Expect {
  try {
    return { ok: true, value: call(fn, a) };
  } catch (e) {
    if (e instanceof ServiceError) {
      const d = e.details as { field?: string } | undefined;
      return { ok: false, code: e.code, field: d?.field ?? null, message: e.message };
    }
    throw e;
  }
}

const helperCases: { name: string; fn: string; args: Args; expect: Expect }[] = [];
const hc = (fn: string, name: string, args: Args): void => {
  helperCases.push({ name: `${fn}: ${name}`, fn, args, expect: record(fn, args) });
};
const SAFE = Number.MAX_SAFE_INTEGER;

const intCase = (name: string, v: unknown, min = 1, max = 10): void =>
  hc('intIn', name, { v, field: 'qty', min, max });
intCase('in range', 5);
intCase('lower bound', 1);
intCase('upper bound', 10);
intCase('below min', 0);
intCase('above max', 11);
intCase('fraction', 1.5);
intCase('numeric string', '5');
intCase('null', null);
intCase('undefined (field missing)', undefined);
intCase('boolean', true);
intCase('array', []);
intCase('object', {});
intCase('1e21', 1e21, 1, 1e22);
intCase('2^53 is not safe', SAFE + 1, 1, Number.MAX_VALUE);
intCase('2^53-1 is safe', SAFE, 1, SAFE);
intCase('negative in negative range', -3, -5, 5);
intCase('integer-valued float 3.0', 3.0);
intCase('tiny fraction', 5e-324);
hc('optIntIn', 'null -> null', { v: null, field: 'n', min: 1, max: 9 });
hc('optIntIn', 'undefined -> null', { v: undefined, field: 'n', min: 1, max: 9 });
hc('optIntIn', 'valid', { v: 3, field: 'n', min: 1, max: 9 });
hc('optIntIn', 'fraction', { v: 1.2, field: 'n', min: 1, max: 9 });

const moneyCase = (name: string, v: unknown, o: Partial<Args> = {}): void =>
  hc('money', name, { v, field: 'amount', ...o });
moneyCase('zero allowed by default', 0);
moneyCase('positive', 100);
moneyCase('negative rejected', -1);
moneyCase('negative allowed', -1, { allowNegative: true });
moneyCase('zero rejected when allowZero=false', 0, { allowZero: false });
moneyCase('fraction', 1.5);
moneyCase('numeric string', '100');
moneyCase('null', null);
moneyCase('undefined', undefined);
moneyCase('2^53 not safe', SAFE + 1);
moneyCase('-(2^53-1) allowed with allowNegative', -SAFE, { allowNegative: true });
moneyCase('2^53-1', SAFE);
moneyCase('boolean', false);

const textCase = (name: string, v: unknown, max = 50): void =>
  hc('optText', name, { v, field: 'note', max });
textCase('undefined -> null', undefined);
textCase('null -> null', null);
textCase('empty -> null', '');
textCase('spaces only -> null', '   ');
textCase('trimmed', '  a b  ');
textCase('number rejected', 123);
textCase('boolean rejected', true);
textCase('too long', 'abcde', 4);
textCase('exactly max after trim', '  abcd  ', 4);
textCase('NBSP trimmed', ' x ');
textCase('BOM (U+FEFF) trimmed', '﻿x﻿');
textCase('NEL (U+0085) NOT trimmed in JS', '\u0085x\u0085');
textCase('LS/PS trimmed', ' x ');
textCase('ideographic space trimmed', '　x　');
textCase('ogham space trimmed', ' x ');
textCase('hair space trimmed', ' x ');
textCase('zero-width space NOT trimmed', '​x​');
textCase('mongolian vowel separator NOT trimmed', '᠎x᠎');
textCase('tabs and newlines trimmed', '\t\n x \r\n');
textCase('urdu trimmed', '  نقد  ');
textCase('emoji counts as 2 UTF-16 units (3 > max)', '😀😀', 3);
textCase('emoji fits (4 <= max)', '😀😀', 4);
textCase('inner whitespace kept', ' a  b ');

// =====================================================================================
// 3. UUID v7 vectors: replay the exact clock + random bytes the TS generator saw
// =====================================================================================
type RngSpec =
  { kind: 'replay'; calls: number[][] } | { kind: 'fixed'; two: [number, number]; fill: number };

interface UuidScenario {
  name: string;
  now_sequence?: number[];
  now_constant?: number;
  count: number;
  rng: RngSpec;
  expected_ids?: string[];
  expected_samples?: { index: number; id: string }[];
  expected_ids_sha256: string;
}

function runUuid(
  name: string,
  clock: { seq: number[] } | { constant: number; count: number },
  rng: { kind: 'seeded'; seed: number } | { kind: 'fixed'; two: [number, number]; fill: number },
  sampleAt?: number[],
): UuidScenario {
  const count = 'seq' in clock ? clock.seq.length : clock.count;
  const nowAt = (i: number): number => ('seq' in clock ? (clock.seq[i] ?? 0) : clock.constant);
  let index = 0; // index of the id currently being generated
  const log: number[][] = [];
  const seeded = rng.kind === 'seeded' ? mulberry32(rng.seed) : mulberry32(0);
  const gen = createUuidV7Generator({
    now: () => nowAt(index),
    randomBytes: (n) => {
      const out =
        rng.kind === 'fixed'
          ? n === 2
            ? Uint8Array.from(rng.two)
            : new Uint8Array(n).fill(rng.fill)
          : Uint8Array.from({ length: n }, () => Math.floor(seeded() * 256));
      log.push([...out]);
      return out;
    },
  });
  const out: string[] = [];
  for (; index < count; index += 1) out.push(gen());
  for (const id of out) if (!isUuidV7(id)) throw new Error(`not a UUID v7: ${id}`);
  const sha = createHash('sha256').update(out.join('\n')).digest('hex');
  const base = {
    name,
    ...('seq' in clock ? { now_sequence: clock.seq } : { now_constant: clock.constant }),
    count,
    rng:
      rng.kind === 'fixed'
        ? ({ kind: 'fixed', two: rng.two, fill: rng.fill } as RngSpec)
        : ({ kind: 'replay', calls: log } as RngSpec),
    expected_ids_sha256: sha,
  };
  return sampleAt
    ? { ...base, expected_samples: sampleAt.map((i) => ({ index: i, id: out[i] ?? '' })) }
    : { ...base, expected_ids: out };
}

const uuidScenarios: UuidScenario[] = [
  runUuid(
    'advancing-ms',
    { seq: [BASE_MS, BASE_MS + 1, BASE_MS + 2, BASE_MS + 1000] },
    { kind: 'seeded', seed: 7 },
  ),
  runUuid(
    'same-ms-counter-increments',
    { seq: Array<number>(5).fill(BASE_MS) },
    { kind: 'seeded', seed: 8 },
  ),
  runUuid(
    'clock-goes-backwards',
    { seq: [2000, 2001, 1500, 1500, 2002] },
    { kind: 'seeded', seed: 9 },
  ),
  // counter starts at 0x7ff (2047); after 2049 more ids it passes 0xfff and the ms must roll forward
  runUuid(
    'counter-overflow-rolls-ms',
    { constant: 3000, count: 2050 },
    { kind: 'fixed', two: [0x07, 0xff], fill: 0xab },
    [0, 1, 2047, 2048, 2049],
  ),
];

// =====================================================================================
// write + self-check (re-read what was written, recompute, compare)
// =====================================================================================
mkdirSync(OUT, { recursive: true });
const invoiceFile = asciiJson({
  description:
    'Golden vectors from the TypeScript reference. C# InvoiceHasher must reproduce canonical and expected_hash exactly.',
  hash_domain: 'pos.invoice.v1',
  vectors,
});
writeFileSync(`${OUT}invoice-vectors.json`, invoiceFile, 'utf8');
writeFileSync(
  `${OUT}helper-vectors.json`,
  asciiJson({
    description:
      'Recorded results of intIn/optIntIn/money/optText. A missing "v" means the field was undefined.',
    cases: helperCases,
  }),
  'utf8',
);
writeFileSync(
  `${OUT}uuid-vectors.json`,
  asciiJson({
    description:
      'UUID v7 generator replay: feed now()/randomBytes() in this order and expect these ids.',
    scenarios: uuidScenarios,
  }),
  'utf8',
);

// The C# Migrator must compute the same checksum for the same .sql file, or a database could not be shared.
const migrations = loadMigrationsFromDir();
writeFileSync(
  `${OUT}migration-checksums.json`,
  asciiJson({
    description:
      'checksum() of every file in packages/db/migrations (SHA-256 of the LF-normalised text). C# Migrator.Checksum must match.',
    migrations: migrations.map((m) => ({
      version: m.version,
      name: m.name,
      checksum: checksum(m.sql),
    })),
  }),
  'utf8',
);

const back = JSON.parse(invoiceFile) as { vectors: InvoiceVector[] };
for (const v of back.vectors) {
  const again = computeInvoiceHash(v.previous_hash, v.unsealed_data);
  if (again !== v.expected_hash) throw new Error(`round-trip mismatch in ${v.name}`);
}

console.log(`invoice vectors : ${vectors.length}  (chain verified, head ${prev.slice(0, 12)}…)`);
console.log(`helper cases    : ${helperCases.length}`);
console.log(`uuid scenarios  : ${uuidScenarios.length}`);
console.log(`migrations      : ${migrations.length}`);
console.log(`written to      : ${OUT}`);
