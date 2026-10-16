import { describe, expect, it } from 'vitest';
import { SERVICE_ERROR_CODES } from '@pos/shared';
import { dynKey, translate } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ur } from '../src/i18n/ur';

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('i18n dictionaries', () => {
  it('en and ur have exactly the same keys', () => {
    expect(Object.keys(ur).sort()).toEqual(Object.keys(en).sort());
  });

  it('no value is empty', () => {
    for (const [k, v] of Object.entries(en)) expect(v.trim(), `en ${k}`).not.toBe('');
    for (const [k, v] of Object.entries(ur)) expect(v.trim(), `ur ${k}`).not.toBe('');
  });

  it('placeholders match between languages', () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(ur[k]), `placeholders of ${k}`).toEqual(placeholders(en[k]));
    }
  });

  it('every ServiceError code has an err.<CODE> message in both languages', () => {
    for (const code of SERVICE_ERROR_CODES) {
      expect(`err.${code}` in en, `err.${code}`).toBe(true);
      expect(`err.${code}` in ur, `err.${code}`).toBe(true);
    }
  });

  it('dynamic key families are complete', () => {
    const families: [string, string[]][] = [
      ['pta', ['approved', 'non_pta', 'jv']],
      ['condition', ['new', 'used', 'open_box']],
      ['method', ['cash', 'khata', 'jazzcash', 'easypaisa', 'bank_transfer', 'card']],
      ['kind', ['sale', 'return', 'void']],
      ['role', ['owner', 'manager', 'cashier']],
      ['approval.reason', ['discount', 'credit_limit', 'return', 'void']],
      [
        'ledger',
        [
          'sale_credit',
          'payment_received',
          'return_credit',
          'purchase_credit',
          'payment_made',
          'purchase_return',
          'opening_balance',
          'adjustment',
        ],
      ],
    ];
    for (const [prefix, values] of families)
      for (const v of values) expect(`${prefix}.${v}` in en, `${prefix}.${v}`).toBe(true);
  });
});

describe('translate', () => {
  it('interpolates placeholders', () => {
    expect(translate('en', 'billing.saleDone', { no: 'A-000007' })).toBe('Sale A-000007 saved');
    expect(translate('ur', 'billing.cappedStock', { n: 3 })).toContain('3');
  });

  it('keeps unknown placeholders visible instead of throwing', () => {
    expect(translate('en', 'billing.saleDone')).toBe('Sale {no} saved');
  });

  it('dynKey falls back for unknown values', () => {
    expect(dynKey('err', 'NOT_A_REAL_CODE')).toBe('err.generic');
    expect(dynKey('pta', 'approved')).toBe('pta.approved');
  });
});
