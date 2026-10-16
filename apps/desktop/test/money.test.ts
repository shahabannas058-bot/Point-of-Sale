import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatRs,
  groupDigits,
  paisaToInput,
  parseRupees,
  percentDiscount,
} from '../src/lib/money';

describe('groupDigits (South Asian lakh grouping)', () => {
  it.each([
    ['0', '0'],
    ['999', '999'],
    ['1000', '1,000'],
    ['12345', '12,345'],
    ['123456', '1,23,456'],
    ['1234567', '12,34,567'],
    ['12345678', '1,23,45,678'],
    ['123456789', '12,34,56,789'],
    ['1234567890', '1,23,45,67,890'],
  ])('lakh %s -> %s', (input, out) => {
    expect(groupDigits(input, 'lakh')).toBe(out);
  });

  it('thousand grouping stays 3-3-3', () => {
    expect(groupDigits('12345678', 'thousand')).toBe('12,345,678');
    expect(groupDigits('1234', 'thousand')).toBe('1,234');
  });
});

describe('formatRs', () => {
  it('formats rupee-only amounts and drops .00', () => {
    expect(formatRs(1_234_567_800)).toBe('Rs 1,23,45,678');
    expect(formatRs(0)).toBe('Rs 0');
    expect(formatRs(8_500_000)).toBe('Rs 85,000');
  });

  it('keeps paisa when non-zero', () => {
    expect(formatRs(150_050)).toBe('Rs 1,500.50');
    expect(formatRs(5)).toBe('Rs 0.05');
    expect(formatRs(1_050)).toBe('Rs 10.50');
  });

  it('puts the minus sign before the symbol', () => {
    expect(formatRs(-250)).toBe('-Rs 2.50');
    expect(formatRs(-1_234_567_800)).toBe('-Rs 1,23,45,678');
  });

  it('supports no symbol and fixed decimals', () => {
    expect(formatAmount(100_000)).toBe('1,000');
    expect(formatAmount(100_000, 'always')).toBe('1,000.00');
    expect(formatRs(100_000, { symbol: null, grouping: 'thousand' })).toBe('1,000');
  });

  it('does not use floating point for large safe integers', () => {
    expect(formatRs(Number.MAX_SAFE_INTEGER, { symbol: null })).toBe('9,00,71,99,25,47,409.91');
  });

  it('shows a dash for values that are not safe integers', () => {
    expect(formatRs(Number.NaN)).toBe('—');
    expect(formatRs(10.5)).toBe('—');
  });
});

describe('parseRupees / paisaToInput', () => {
  it('parses user input into integer paisa without float maths', () => {
    expect(parseRupees('1,500.50')).toBe(150_050);
    expect(parseRupees('0.1')).toBe(10);
    expect(parseRupees('  45000 ')).toBe(4_500_000);
    expect(parseRupees('1.15')).toBe(115);
  });

  it('rejects garbage and negatives', () => {
    expect(parseRupees('')).toBeNull();
    expect(parseRupees('abc')).toBeNull();
    expect(parseRupees('-5')).toBeNull();
    expect(parseRupees('1.234')).toBeNull();
  });

  it('round-trips through the editable string', () => {
    for (const p of [0, 5, 10, 100, 150_050, 8_500_000, 123_456_789]) {
      expect(parseRupees(paisaToInput(p))).toBe(p);
    }
    expect(paisaToInput(150_050)).toBe('1500.5');
    expect(paisaToInput(8_500_000)).toBe('85000');
  });
});

describe('percentDiscount', () => {
  it('converts percent into paisa through core (half-up)', () => {
    expect(percentDiscount(8_500_000 as never, '5')).toBe(425_000);
    expect(percentDiscount(10_001 as never, '10')).toBe(1_000);
    expect(percentDiscount(10_005 as never, '10')).toBe(1_001);
  });

  it('rejects out-of-range or empty input', () => {
    expect(percentDiscount(100 as never, '')).toBeNull();
    expect(percentDiscount(100 as never, '101')).toBeNull();
    expect(percentDiscount(100 as never, '-1')).toBeNull();
    expect(percentDiscount(100 as never, 'x')).toBeNull();
  });
});
