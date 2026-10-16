import { describe, expect, it } from 'vitest';
import {
  addPaisa,
  allocate,
  applyPercentDiscount,
  assertPaymentsMatchTotal,
  formatPaisa,
  lineTotal,
  mulPaisa,
  negPaisa,
  paisa,
  percentOf,
  percentToBps,
  rupeesToPaisa,
  saleTotals,
  splitEvenly,
  subPaisa,
  sumPaisa,
  ZERO,
  type RoundingMode,
} from '@pos/core';
import { expectDomainError, mulberry32, randInt } from './fixtures';

const p = paisa;

describe('rupeesToPaisa', () => {
  it.each([
    ['1,999.50', 199950],
    ['19.99', 1999],
    ['0.1', 10],
    ['5', 500],
    ['-5.5', -550],
    ['0', 0],
    ['  7.05 ', 705],
  ])('parses %j as %i paisa', (input, expected) => {
    expect(rupeesToPaisa(input)).toBe(expected);
  });

  it('avoids the float trap (19.99 * 100 is 1998.9999999999998)', () => {
    expect(19.99 * 100).not.toBe(1999);
    expect(rupeesToPaisa('19.99')).toBe(1999);
  });

  it.each(['1.999', '', 'abc', '1.2.3', '.5', '5.', '--5', '1e3'])('rejects %j', (input) => {
    expectDomainError(() => rupeesToPaisa(input), 'MONEY_INVALID');
  });
});

describe('percent discount', () => {
  it('10% of Rs 1,999.50 is exact', () => {
    expect(percentOf(p(199950), 1000)).toBe(19995);
    expect(applyPercentDiscount(p(199950), 1000)).toEqual({ discount: 19995, net: 179955 });
  });

  it('7.5% of Rs 1,999.50 = 14996.25 rounds to 14996', () => {
    expect(percentOf(p(199950), 750)).toBe(14996);
  });

  it.each<[RoundingMode, number]>([
    ['half-up', 29993],
    ['half-even', 29992],
    ['floor', 29992],
    ['ceil', 29993],
  ])('15 percent tie (29992.5) with %s gives %i', (mode, expected) => {
    expect(percentOf(p(199950), 1500, mode)).toBe(expected);
  });

  it.each<[RoundingMode, number]>([
    ['half-up', 24994],
    ['half-even', 24994],
    ['floor', 24993],
    ['ceil', 24994],
  ])('12.5 percent (24993.75) with %s gives %i', (mode, expected) => {
    expect(percentOf(p(199950), 1250, mode)).toBe(expected);
  });

  it.each<[RoundingMode, number]>([
    ['half-up', -29993],
    ['half-even', -29992],
    ['floor', -29993],
    ['ceil', -29992],
  ])('negative amount (returns) 15 percent tie with %s gives %i', (mode, expected) => {
    expect(percentOf(p(-199950), 1500, mode)).toBe(expected);
  });

  it('half-even rounds ties to the even neighbour', () => {
    // 5 paisa * 50% = 2.5 -> 2 (even); 7 paisa * 50% = 3.5 -> 4 (even)
    expect(percentOf(p(5), 5000, 'half-even')).toBe(2);
    expect(percentOf(p(7), 5000, 'half-even')).toBe(4);
    expect(percentOf(p(-7), 5000, 'half-even')).toBe(-4);
  });

  it('floor and ceil do nothing when the result is exact', () => {
    expect(percentOf(p(1000), 1000, 'floor')).toBe(100);
    expect(percentOf(p(1000), 1000, 'ceil')).toBe(100);
  });

  it('discount + net always equals the amount', () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 300; i++) {
      const amount = p(randInt(rand, 0, 50_000_000));
      const bps = randInt(rand, 0, 10_000);
      const { discount, net } = applyPercentDiscount(amount, bps);
      expect(discount + net).toBe(amount);
      expect(net).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles basis-point bounds', () => {
    expect(percentOf(p(199950), 0)).toBe(0);
    expect(percentOf(p(199950), 10_000)).toBe(199950);
    expect(applyPercentDiscount(p(199950), 10_000)).toEqual({ discount: 199950, net: 0 });
  });

  it.each([10_001, -1, 7.5])('applyPercentDiscount rejects bps %s', (bps) => {
    expectDomainError(() => applyPercentDiscount(p(1000), bps), 'DISCOUNT_INVALID');
  });

  it('percentOf allows markup above 100% but not above 10,000%', () => {
    expect(percentOf(p(1000), 20_000)).toBe(2000);
    expectDomainError(() => percentOf(p(1000), 1_000_001), 'DISCOUNT_INVALID');
  });

  it('percentToBps converts UI percent', () => {
    expect(percentToBps(7.5)).toBe(750);
    expect(percentToBps(0.07)).toBe(7);
    expect(percentToBps(15)).toBe(1500);
    expectDomainError(() => percentToBps(Number.NaN), 'DISCOUNT_INVALID');
    expectDomainError(() => percentToBps(Number.POSITIVE_INFINITY), 'DISCOUNT_INVALID');
  });

  it('does not overflow near the safe-integer limit', () => {
    expect(percentOf(p(9_000_000_000_000_000), 5000)).toBe(4_500_000_000_000_000);
  });
});

describe('splitEvenly', () => {
  it('splits 1000 three ways with the remainder on the first part', () => {
    const parts = splitEvenly(p(1000), 3);
    expect(parts).toEqual([334, 333, 333]);
    expect(sumPaisa(parts)).toBe(1000);
  });

  it('handles small, negative and zero totals', () => {
    expect(splitEvenly(p(1), 3)).toEqual([1, 0, 0]);
    expect(splitEvenly(p(-1000), 3)).toEqual([-334, -333, -333]);
    expect(splitEvenly(p(0), 4)).toEqual([0, 0, 0, 0]);
  });

  it.each([0, -1, 1.5])('rejects %s parts', (parts) => {
    expectDomainError(() => splitEvenly(p(100), parts), 'MONEY_INVALID');
  });

  it('property: 500 random splits sum exactly and differ by at most 1', () => {
    const rand = mulberry32(2024);
    for (let i = 0; i < 500; i++) {
      const total = p(randInt(rand, -2_000_000_000, 2_000_000_000));
      const parts = randInt(rand, 1, 50);
      const split = splitEvenly(total, parts);
      expect(split).toHaveLength(parts);
      expect(sumPaisa(split)).toBe(total);
      expect(Math.max(...split) - Math.min(...split)).toBeLessThanOrEqual(1);
    }
  });
});

describe('allocate', () => {
  it('follows weights exactly when divisible', () => {
    expect(allocate(p(100), [50, 30, 20])).toEqual([50, 30, 20]);
  });

  it('gives the leftover paisa to the largest remainder', () => {
    expect(allocate(p(100), [1, 2])).toEqual([33, 67]);
    expect(allocate(p(10), [0, 1, 1])).toEqual([0, 5, 5]);
  });

  it('allocates negative totals on the magnitude', () => {
    expect(allocate(p(-100), [1, 2])).toEqual([-33, -67]);
  });

  it('rejects empty, all-zero, negative and non-integer weights', () => {
    expectDomainError(() => allocate(p(5), [0, 0]), 'MONEY_INVALID');
    expectDomainError(() => allocate(p(5), []), 'MONEY_INVALID');
    expectDomainError(() => allocate(p(5), [1, -1]), 'MONEY_INVALID');
    expectDomainError(() => allocate(p(5), [1.5]), 'MONEY_INVALID');
  });

  it('prorates an invoice discount of 10000 over [19995, 30005, 50000] to exactly 10000', () => {
    const shares = allocate(p(10_000), [19_995, 30_005, 50_000]);
    expect(sumPaisa(shares)).toBe(10_000);
    // exact shares are 1999.5, 3000.5, 5000: the tie goes to the lowest index
    expect(shares).toEqual([2000, 3000, 5000]);
  });
});

describe('assertPaymentsMatchTotal', () => {
  it('accepts exact split payments', () => {
    expect(() =>
      assertPaymentsMatchTotal(p(150000), [
        { method: 'cash', amount: p(100000) },
        { method: 'khata', amount: p(50000) },
      ]),
    ).not.toThrow();
  });

  it('reports a one-paisa shortfall', () => {
    const error = expectDomainError(
      () =>
        assertPaymentsMatchTotal(p(150000), [
          { method: 'cash', amount: p(100000) },
          { method: 'khata', amount: p(49999) },
        ]),
      'PAYMENT_MISMATCH',
    );
    expect(error.message).toContain('difference 1');
  });

  it('rejects overpayment, zero parts and wrong-sign parts', () => {
    expectDomainError(
      () => assertPaymentsMatchTotal(p(150000), [{ method: 'cash', amount: p(150001) }]),
      'PAYMENT_MISMATCH',
    );
    expectDomainError(
      () =>
        assertPaymentsMatchTotal(p(150000), [
          { method: 'cash', amount: p(150000) },
          { method: 'khata', amount: p(0) },
        ]),
      'PAYMENT_MISMATCH',
    );
    expectDomainError(
      () => assertPaymentsMatchTotal(p(150000), [{ method: 'cash', amount: p(-50000) }]),
      'PAYMENT_MISMATCH',
    );
  });

  it('handles zero-total and refund invoices', () => {
    expect(() => assertPaymentsMatchTotal(p(0), [])).not.toThrow();
    expectDomainError(
      () => assertPaymentsMatchTotal(p(0), [{ method: 'cash', amount: p(0) }]),
      'PAYMENT_MISMATCH',
    );
    expect(() =>
      assertPaymentsMatchTotal(p(-50000), [{ method: 'cash', amount: p(-50000) }]),
    ).not.toThrow();
  });
});

describe('lineTotal and saleTotals', () => {
  it('computes line totals, subtotal and total', () => {
    const totals = saleTotals(
      [
        { quantity: 2, unitPrice: p(50000), discountAmount: p(0) },
        { quantity: 1, unitPrice: p(199950), discountAmount: p(19995) },
      ],
      p(5000),
    );
    expect(totals.lineTotals).toEqual([100000, 179955]);
    expect(totals.subtotal).toBe(279955);
    expect(totals.total).toBe(274955);
  });

  it('rejects a line discount above the gross', () => {
    expectDomainError(
      () => lineTotal({ quantity: 1, unitPrice: p(1000), discountAmount: p(1001) }),
      'DISCOUNT_INVALID',
    );
    expectDomainError(
      () => lineTotal({ quantity: 1, unitPrice: p(1000), discountAmount: p(-1) }),
      'DISCOUNT_INVALID',
    );
  });

  it('rejects an invoice discount above the subtotal', () => {
    expectDomainError(
      () => saleTotals([{ quantity: 1, unitPrice: p(1000), discountAmount: p(0) }], p(1001)),
      'DISCOUNT_INVALID',
    );
  });

  it('prices a return line with negative quantity and discount', () => {
    expect(lineTotal({ quantity: -1, unitPrice: p(199950), discountAmount: p(-19995) })).toBe(
      -179955,
    );
  });

  it('rejects zero or fractional quantities', () => {
    expectDomainError(
      () => lineTotal({ quantity: 0, unitPrice: p(100), discountAmount: p(0) }),
      'MONEY_INVALID',
    );
    expectDomainError(
      () => lineTotal({ quantity: 1.5, unitPrice: p(100), discountAmount: p(0) }),
      'MONEY_INVALID',
    );
  });

  it('rejects mixed-sign and empty invoices', () => {
    expectDomainError(
      () =>
        saleTotals(
          [
            { quantity: 1, unitPrice: p(100), discountAmount: p(0) },
            { quantity: -1, unitPrice: p(100), discountAmount: p(0) },
          ],
          p(0),
        ),
      'MONEY_INVALID',
    );
    expectDomainError(() => saleTotals([], p(0)), 'MONEY_INVALID');
  });
});

describe('safe-integer guard and arithmetic helpers', () => {
  it('rejects non-integers and overflow with MONEY_INVALID', () => {
    expectDomainError(() => paisa(1.5), 'MONEY_INVALID');
    expectDomainError(() => paisa(Number.NaN), 'MONEY_INVALID');
    expectDomainError(() => paisa(Number.POSITIVE_INFINITY), 'MONEY_INVALID');
    expectDomainError(() => addPaisa(p(Number.MAX_SAFE_INTEGER), p(1)), 'MONEY_INVALID');
  });

  it('normalises negative zero', () => {
    expect(Object.is(paisa(-0), 0)).toBe(true);
    expect(Object.is(negPaisa(ZERO), 0)).toBe(true);
  });

  it('add, subtract, negate, sum and multiply', () => {
    expect(addPaisa(p(100), p(250))).toBe(350);
    expect(subPaisa(p(100), p(250))).toBe(-150);
    expect(negPaisa(p(100))).toBe(-100);
    expect(sumPaisa([])).toBe(0);
    expect(sumPaisa([p(1), p(2), p(3)])).toBe(6);
    expect(mulPaisa(p(50000), 3)).toBe(150000);
    expectDomainError(() => mulPaisa(p(50000), 1.5), 'MONEY_INVALID');
  });
});

describe('formatPaisa', () => {
  it.each([
    [199950, '1,999.50'],
    [5, '0.05'],
    [-100050, '-1,000.50'],
    [0, '0.00'],
    [100, '1.00'],
    [123456789, '1,234,567.89'],
  ])('formats %i as %s', (value, expected) => {
    expect(formatPaisa(p(value))).toBe(expected);
  });

  it('round-trips with rupeesToPaisa for 1000 random amounts', () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const x = p(randInt(rand, -5_000_000_000_000, 5_000_000_000_000));
      expect(rupeesToPaisa(formatPaisa(x))).toBe(x);
    }
  });
});
