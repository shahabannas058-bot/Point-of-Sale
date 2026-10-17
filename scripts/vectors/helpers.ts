import { isServiceError } from '@pos/shared';
import { intIn, money, optIntIn, optText } from '../../packages/db/src/service/errors';

/** Shape read by HelperVectorTests (GoldenVectorTests.cs). A missing `v` key means JS `undefined`. */
interface HelperArgs {
  v?: unknown;
  field: string;
  min?: number;
  max?: number;
  allowZero?: boolean;
  allowNegative?: boolean;
}

type HelperFn = 'intIn' | 'optIntIn' | 'money' | 'optText';

type HelperExpect =
  | { ok: true; value: number | string | null }
  | { ok: false; code: string; message: string; field: string | null };

export interface HelperCase {
  name: string;
  fn: HelperFn;
  args: HelperArgs;
  expect: HelperExpect;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UNDEFINED = Symbol('undefined');

interface CaseSpec {
  name: string;
  fn: HelperFn;
  /** UNDEFINED = the key is left out (JS undefined). */
  v: unknown;
  field?: string;
  min?: number;
  max?: number;
  allowZero?: boolean;
  allowNegative?: boolean;
}

const need = (value: number | undefined, what: string, name: string): number => {
  if (value === undefined) throw new Error(`${name}: ${what} is required`);
  return value;
};

/** Calls the TypeScript helper exactly as the service does (undefined opts = defaults). */
function run(spec: CaseSpec, v: unknown, field: string): number | string | null {
  switch (spec.fn) {
    case 'intIn':
      return intIn(v, field, need(spec.min, 'min', spec.name), need(spec.max, 'max', spec.name));
    case 'optIntIn':
      return optIntIn(v, field, need(spec.min, 'min', spec.name), need(spec.max, 'max', spec.name));
    case 'money':
      return money(v, field, { allowZero: spec.allowZero, allowNegative: spec.allowNegative });
    case 'optText':
      return optText(v, field, need(spec.max, 'max', spec.name));
  }
}

function toCase(spec: CaseSpec): HelperCase {
  const field = spec.field ?? 'amount';
  const v = spec.v === UNDEFINED ? undefined : spec.v;
  const args: HelperArgs = { field };
  if (spec.v !== UNDEFINED) args.v = spec.v;
  if (spec.min !== undefined) args.min = spec.min;
  if (spec.max !== undefined) args.max = spec.max;
  if (spec.allowZero !== undefined) args.allowZero = spec.allowZero;
  if (spec.allowNegative !== undefined) args.allowNegative = spec.allowNegative;

  let expect: HelperExpect;
  try {
    expect = { ok: true, value: run(spec, v, field) };
  } catch (e) {
    if (!isServiceError(e)) throw e;
    const f = e.details['field'];
    expect = {
      ok: false,
      code: e.code,
      message: e.message,
      field: typeof f === 'string' ? f : null,
    };
  }
  return { name: spec.name, fn: spec.fn, args, expect };
}

const SPECS: readonly CaseSpec[] = [
  // ---- intIn ----
  { name: 'intIn ok inside range', fn: 'intIn', v: 5, field: 'quantity', min: 1, max: 10 },
  { name: 'intIn ok at min', fn: 'intIn', v: 1, field: 'quantity', min: 1, max: 10 },
  { name: 'intIn ok at max', fn: 'intIn', v: 10, field: 'quantity', min: 1, max: 10 },
  { name: 'intIn ok negative range', fn: 'intIn', v: -3, field: 'quantity', min: -5, max: -1 },
  { name: 'intIn ok max safe', fn: 'intIn', v: MAX_SAFE, field: 'n', min: 0, max: MAX_SAFE },
  { name: 'intIn below min', fn: 'intIn', v: 0, field: 'lines.0.quantity', min: 1, max: 999 },
  { name: 'intIn above max', fn: 'intIn', v: 1000, field: 'lines.0.quantity', min: 1, max: 999 },
  { name: 'intIn fraction', fn: 'intIn', v: 1.5, field: 'quantity', min: 1, max: 10 },
  { name: 'intIn numeric string', fn: 'intIn', v: '5', field: 'quantity', min: 1, max: 10 },
  { name: 'intIn boolean', fn: 'intIn', v: true, field: 'quantity', min: 0, max: 10 },
  { name: 'intIn null', fn: 'intIn', v: null, field: 'quantity', min: 1, max: 10 },
  { name: 'intIn undefined', fn: 'intIn', v: UNDEFINED, field: 'quantity', min: 1, max: 10 },
  { name: 'intIn 2^53 not safe', fn: 'intIn', v: MAX_SAFE + 1, field: 'n', min: 0, max: MAX_SAFE },
  { name: 'intIn 1e21 bound printed like JS', fn: 'intIn', v: -1, field: 'n', min: 0, max: 1e21 },
  { name: 'intIn 1e-7 bound printed like JS', fn: 'intIn', v: -1, field: 'n', min: -1e-7, max: 1 },
  { name: 'intIn huge value', fn: 'intIn', v: 1e21, field: 'n', min: 0, max: 1e22 },
  { name: 'intIn object', fn: 'intIn', v: { n: 1 }, field: 'n', min: 0, max: 10 },
  // ---- optIntIn ----
  { name: 'optIntIn null', fn: 'optIntIn', v: null, field: 'ramGb', min: 1, max: 64 },
  { name: 'optIntIn undefined', fn: 'optIntIn', v: UNDEFINED, field: 'ramGb', min: 1, max: 64 },
  { name: 'optIntIn ok', fn: 'optIntIn', v: 8, field: 'ramGb', min: 1, max: 64 },
  { name: 'optIntIn string', fn: 'optIntIn', v: '8', field: 'ramGb', min: 1, max: 64 },
  { name: 'optIntIn out of range', fn: 'optIntIn', v: 99, field: 'ramGb', min: 1, max: 64 },
  { name: 'optIntIn fraction', fn: 'optIntIn', v: 0.5, field: 'ramGb', min: 0, max: 64 },
  // ---- money ----
  { name: 'money ok', fn: 'money', v: 199_950, field: 'unitPrice' },
  { name: 'money zero allowed by default', fn: 'money', v: 0, field: 'unitPrice' },
  { name: 'money zero not allowed', fn: 'money', v: 0, field: 'amount', allowZero: false },
  { name: 'money negative', fn: 'money', v: -5, field: 'amount' },
  { name: 'money negative allowed', fn: 'money', v: -5, field: 'amount', allowNegative: true },
  {
    name: 'money negative, zero disallowed, negative allowed',
    fn: 'money',
    v: -1,
    field: 'amount',
    allowZero: false,
    allowNegative: true,
  },
  { name: 'money fraction', fn: 'money', v: 1.5, field: 'lines.0.unitPrice' },
  { name: 'money numeric string', fn: 'money', v: '100', field: 'amount' },
  { name: 'money null', fn: 'money', v: null, field: 'amount' },
  { name: 'money undefined', fn: 'money', v: UNDEFINED, field: 'amount' },
  { name: 'money boolean', fn: 'money', v: false, field: 'amount' },
  { name: 'money max safe', fn: 'money', v: MAX_SAFE, field: 'amount' },
  { name: 'money 2^53', fn: 'money', v: MAX_SAFE + 1, field: 'amount' },
  { name: 'money -max safe', fn: 'money', v: -MAX_SAFE, field: 'amount', allowNegative: true },
  { name: 'money negative fraction', fn: 'money', v: -0.5, field: 'amount', allowNegative: true },
  // ---- optText ----
  { name: 'optText undefined', fn: 'optText', v: UNDEFINED, field: 'note', max: 10 },
  { name: 'optText null', fn: 'optText', v: null, field: 'note', max: 10 },
  { name: 'optText trims', fn: 'optText', v: '  hi  ', field: 'note', max: 10 },
  { name: 'optText blank is null', fn: 'optText', v: ' \t\n ', field: 'note', max: 10 },
  { name: 'optText empty is null', fn: 'optText', v: '', field: 'note', max: 10 },
  { name: 'optText Urdu', fn: 'optText', v: '  نقد ادائیگی  ', field: 'note', max: 20 },
  { name: 'optText JS trims BOM', fn: 'optText', v: '﻿x﻿', field: 'note', max: 10 },
  { name: 'optText JS keeps NEL', fn: 'optText', v: '\u0085x\u0085', field: 'note', max: 10 },
  {
    name: 'optText JS trims nbsp, ideographic space, LS/PS',
    fn: 'optText',
    v: ' 　 x y    ',
    field: 'note',
    max: 10,
  },
  { name: 'optText exactly max', fn: 'optText', v: 'abcde', field: 'note', max: 5 },
  { name: 'optText over max', fn: 'optText', v: 'abcdef', field: 'note', max: 5 },
  { name: 'optText max counts after trim', fn: 'optText', v: '  abcde  ', field: 'note', max: 5 },
  {
    name: 'optText emoji counts UTF-16 units',
    fn: 'optText',
    v: '😀😀',
    field: 'description',
    max: 3,
  },
  { name: 'optText number', fn: 'optText', v: 5, field: 'note', max: 10 },
  { name: 'optText boolean', fn: 'optText', v: true, field: 'note', max: 10 },
  { name: 'optText array', fn: 'optText', v: ['a'], field: 'note', max: 10 },
];

export function buildHelperCases(): HelperCase[] {
  const cases = SPECS.map(toCase);
  const names = new Set(cases.map((c) => c.name));
  if (names.size !== cases.length) throw new Error('helper case names must be unique');
  return cases;
}
