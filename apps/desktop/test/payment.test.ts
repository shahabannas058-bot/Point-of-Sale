import { describe, expect, it } from 'vitest';
import { paymentReady } from '../src/lib/payment';

describe('paymentReady: when the payment panel lets Confirm through', () => {
  it('a zero total is paid with no payment rows at all (QA#12)', () => {
    expect(paymentReady([], 0, false)).toBe(true);
    expect(paymentReady([{ method: 'cash', paisa: 0 }], 0, false)).toBe(false);
  });

  it('rows must be positive and add up to the total exactly', () => {
    expect(paymentReady([], 500, false)).toBe(false);
    expect(paymentReady([{ method: 'cash', paisa: 500 }], 500, false)).toBe(true);
    expect(paymentReady([{ method: 'cash', paisa: 400 }], 500, false)).toBe(false);
    expect(
      paymentReady(
        [
          { method: 'cash', paisa: 600 },
          { method: 'jazzcash', paisa: -100 },
        ],
        500,
        false,
      ),
    ).toBe(false);
    expect(paymentReady([{ method: 'cash', paisa: null }], 0, false)).toBe(false);
  });

  it('khata needs a customer', () => {
    expect(paymentReady([{ method: 'khata', paisa: 500 }], 500, false)).toBe(false);
    expect(paymentReady([{ method: 'khata', paisa: 500 }], 500, true)).toBe(true);
  });
});
