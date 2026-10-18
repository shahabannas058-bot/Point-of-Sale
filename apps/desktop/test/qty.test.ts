import { describe, expect, it } from 'vitest';
import {
  QUICK_AMOUNTS,
  labelFor,
  parseSignedQuantity,
  perUnit,
  qtyStep,
  qtyText,
  quantityForAmount,
  quickLabel,
  variantQtyText,
  weightForAmount,
  adjustmentDelta,
  qtyWithUnit,
  unitWord,
} from '../src/lib/qty';
import { lineGross } from '@pos/shared';

describe('qtyText: what the cashier reads next to an item', () => {
  it.each([
    [3, 1, 'pcs', '3'],
    [1250, 1000, 'kg', '1.25 kg'],
    [500, 1000, 'L', '0.5 L'],
    [1000, 1000, 'kg', '1 kg'],
    [0, 1000, 'kg', '0 kg'],
  ] as const)('%d (scale %d, %s) -> "%s"', (q, scale, unit, text) => {
    expect(qtyText(q, scale, unit)).toBe(text);
  });
});

describe('perUnit: suffix after a price', () => {
  it('pieces have none, weighed goods say per kg / per litre', () => {
    expect(perUnit(1, 'pcs')).toBe('');
    expect(perUnit(1000, 'kg')).toBe('/kg');
    expect(perUnit(1000, 'L')).toBe('/L');
  });
});

describe('labelFor: an invoice line only knows its scale', () => {
  it('weighed goods default to kg', () => {
    expect(labelFor(1)).toBe('pcs');
    expect(labelFor(1000)).toBe('kg');
  });
});

describe('quick weight buttons', () => {
  it('are 250 g, 500 g and 1 kg', () => {
    expect([...QUICK_AMOUNTS]).toEqual([250, 500, 1000]);
    expect(QUICK_AMOUNTS.map((a) => quickLabel(a, 'kg'))).toEqual(['250 g', '500 g', '1 kg']);
  });

  it('use ml and L for liquids', () => {
    expect(QUICK_AMOUNTS.map((a) => quickLabel(a, 'L'))).toEqual(['250 ml', '500 ml', '1 L']);
  });
});

describe('qtyStep: what + and - change', () => {
  it('is one piece, or 250 g for weighed goods', () => {
    expect(qtyStep(1)).toBe(1);
    expect(qtyStep(1000)).toBe(250);
  });
});

describe('parseSignedQuantity: the stock-adjustment box', () => {
  it.each([
    ['-0.5', 1000, -500],
    ['2.25', 1000, 2250],
    ['-3', 1, -3],
    ['4', 1, 4],
    ['0', 1000, 0],
  ] as const)('"%s" (scale %d) -> %d', (text, scale, expected) => {
    expect(parseSignedQuantity(text, scale)).toBe(expected);
  });

  it('never returns negative zero', () => {
    expect(parseSignedQuantity('-0', 1)).toBe(0);
    expect(parseSignedQuantity('-0.000', 1000)).toBe(0);
  });

  it.each([
    ['', 1000],
    ['-', 1000],
    ['+2', 1000],
    ['--1', 1000],
    ['1.5', 1], // pieces are whole numbers
    ['1.2345', 1000],
    ['abc', 1000],
  ] as const)('"%s" (scale %d) is not a quantity', (text, scale) => {
    expect(parseSignedQuantity(text, scale)).toBeNull();
  });
});

describe('quantityForAmount: the cashier types rupees, the weight fills in', () => {
  const ATTA = 15_000; // Rs 150 per kg, in paisa

  it.each([
    [15_000, 1000], // Rs 150 buys exactly 1 kg
    [7_500, 500], // Rs 75 -> 500 g
    [10_000, 667], // Rs 100 -> 666.67 g, to the nearest gram
    [1_500, 100], // Rs 15 -> 100 g
    [30_000, 2000],
  ])('Rs %d paisa at Rs 150/kg -> %d g', (amount, grams) => {
    expect(quantityForAmount(amount, ATTA, 1000)).toBe(grams);
  });

  it('works with a price that is not a whole number of rupees', () => {
    expect(quantityForAmount(100_000, 28_550, 1000)).toBe(3503); // Rs 1,000 at Rs 285.50/kg = 3,502.6 g
  });

  it('rounds half up to the nearest gram', () => {
    expect(quantityForAmount(15, 30_000, 1000)).toBe(1); // 0.5 g
    expect(quantityForAmount(14, 30_000, 1000)).toBeNull(); // 0.47 g buys nothing
  });

  it('gives null when nothing can be bought', () => {
    expect(quantityForAmount(0, ATTA, 1000)).toBeNull();
    expect(quantityForAmount(10_000, 0, 1000)).toBeNull();
    expect(quantityForAmount(5, ATTA, 1000)).toBeNull(); // 5 paisa is a third of a gram
  });

  it('never gives a fractional or unsafe quantity', () => {
    const q = quantityForAmount(99_999_999_999, 1, 1000);
    expect(q === null || Number.isSafeInteger(q)).toBe(true);
    expect(quantityForAmount(Number.NaN, ATTA, 1000)).toBeNull();
    expect(quantityForAmount(-100, ATTA, 1000)).toBeNull();
  });

  it('the weight it gives is priced within half a gram of the rupees typed', () => {
    for (const amount of [100, 1_234, 10_000, 55_555, 123_456]) {
      const grams = quantityForAmount(amount, ATTA, 1000);
      expect(grams).not.toBeNull();
      const back = lineGross(grams ?? 0, ATTA, 1000);
      expect(Math.abs(back - amount)).toBeLessThanOrEqual(ATTA / 1000 / 2 + 1);
    }
  });
});

describe('weightForAmount: the typed rupees become the line total, to the paisa', () => {
  const ATTA = 15_000; // Rs 150 per kg

  it('a round weight needs no round-off', () => {
    expect(weightForAmount(15_000, ATTA, 1000)).toEqual({ quantity: 1000, discount: 0 });
    expect(weightForAmount(7_500, ATTA, 1000)).toEqual({ quantity: 500, discount: 0 });
  });

  it('Rs 100 at Rs 150/kg is 667 g, and the 5 paisa over come off as a discount', () => {
    // 667 g costs Rs 100.05; minus 5 paisa the customer pays exactly Rs 100
    expect(weightForAmount(10_000, ATTA, 1000)).toEqual({ quantity: 667, discount: 5 });
  });

  it('works for a price in paisa: Rs 1,000 at Rs 285.50/kg', () => {
    // 3503 g costs 28,550 x 3503 / 1000 = 100,010.65 -> 100,011 paisa; minus 11 the line is exactly Rs 1,000
    expect(weightForAmount(100_000, 28_550, 1000)).toEqual({ quantity: 3503, discount: 11 });
  });

  it('from Rs 100 up, the line total (price of the weight minus the discount) is exactly the typed amount', () => {
    for (const price of [15_000, 28_550, 33_300, 125_000]) {
      for (const amount of [10_000, 12_345, 55_555, 100_000]) {
        const w = weightForAmount(amount, price, 1000);
        if (w === null) continue;
        expect(lineGross(w.quantity, price, 1000) - w.discount, `Rs ${amount}p @ ${price}`).toBe(
          amount,
        );
        expect(w.discount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('never takes more than 1 % off: a tiny amount keeps the nearest weight and no discount', () => {
    // Rs 1 at Rs 285.50/kg is 3.5 g: 4 g would cost Rs 1.14, a 14 paisa (12 %) round-off is not a round-off
    expect(weightForAmount(100, 28_550, 1000)).toEqual({ quantity: 4, discount: 0 });
    for (const amount of [100, 150, 300, 777, 2_000, 10_000]) {
      const w = weightForAmount(amount, 28_550, 1000);
      if (w === null) continue;
      const gross = lineGross(w.quantity, 28_550, 1000);
      expect(w.discount * 100).toBeLessThanOrEqual(gross);
    }
  });

  it('gives null when nothing can be bought', () => {
    expect(weightForAmount(0, ATTA, 1000)).toBeNull();
    expect(weightForAmount(10_000, 0, 1000)).toBeNull();
    expect(weightForAmount(5, ATTA, 1000)).toBeNull();
    expect(weightForAmount(Number.NaN, ATTA, 1000)).toBeNull();
  });
});

describe('unitWord and qtyWithUnit: the unit is always written next to a stock number', () => {
  it('names the unit in plain words', () => {
    expect(unitWord('pcs', 'piece')).toBe('piece');
    expect(unitWord('kg', 'piece')).toBe('kg');
    expect(unitWord('L', 'piece')).toBe('litre');
  });

  it.each([
    [3, 1, 'pcs', '3 piece'],
    [1, 1, 'pcs', '1 piece'],
    [3000, 1000, 'kg', '3 kg'],
    [500, 1000, 'kg', '0.5 kg'],
    [1250, 1000, 'kg', '1.25 kg'],
    [2000, 1000, 'L', '2 litre'],
    [0, 1, 'pcs', '0 piece'],
  ] as const)('%d (scale %d, %s) -> "%s"', (q, scale, unit, text) => {
    expect(qtyWithUnit(q, scale, unit, 'piece')).toBe(text);
  });

  it('uses the language word for a piece', () => {
    expect(qtyWithUnit(3, 1, 'pcs', 'dana')).toBe('3 dana');
  });
});

describe('adjustmentDelta: the cashier picks add or remove and types a plain number', () => {
  it('add is positive, remove is negative', () => {
    expect(adjustmentDelta('add', '2', 1)).toBe(2);
    expect(adjustmentDelta('remove', '2', 1)).toBe(-2);
  });

  it('weighed goods accept halves and quarters, in base units', () => {
    expect(adjustmentDelta('add', '0.5', 1000)).toBe(500);
    expect(adjustmentDelta('remove', '0.25', 1000)).toBe(-250);
    expect(adjustmentDelta('add', '1', 1000)).toBe(1000);
    expect(adjustmentDelta('add', '3', 1000)).toBe(3000);
  });

  it('a piece item takes whole numbers only', () => {
    expect(adjustmentDelta('add', '1.5', 1)).toBeNull();
  });

  it('nothing, zero, a sign or text is not an amount', () => {
    for (const bad of ['', '  ', '0', '0.0', '-2', '+2', 'abc', '1.2345']) {
      expect(adjustmentDelta('add', bad, 1000), bad).toBeNull();
    }
    expect(adjustmentDelta('remove', '0', 1)).toBeNull();
  });

  it('never gives negative zero', () => {
    expect(Object.is(adjustmentDelta('remove', '0', 1000), -0)).toBe(false);
  });
});

describe('variantQtyText: a stock number in the item own unit', () => {
  it('uses the variant unit', () => {
    expect(variantQtyText(1250, { unitScale: 1000, unitLabel: 'kg' })).toBe('1.25 kg');
    expect(variantQtyText(3, { unitScale: 1, unitLabel: 'pcs' })).toBe('3');
  });
});
