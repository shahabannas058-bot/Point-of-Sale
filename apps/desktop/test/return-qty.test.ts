import { describe, expect, it } from 'vitest';
import { hasBadPick, remainingText, returnPick, returnPickList } from '../src/lib/return-qty';

const pieces = { unitScale: 1, remainingQty: 3 } as const;
const weighed = { unitScale: 1000, remainingQty: 1500 } as const; // 1.5 kg left to return

describe('returnPick: piece items behave as before', () => {
  it('keeps digits only and counts them as pieces', () => {
    expect(returnPick('2', pieces)).toEqual({ text: '2', quantity: 2, status: 'ok' });
    expect(returnPick('2a', pieces)).toEqual({ text: '2', quantity: 2, status: 'ok' });
  });

  it('holds the number at what is left to return', () => {
    expect(returnPick('25', pieces)).toEqual({ text: '3', quantity: 3, status: 'ok' });
  });

  it('an empty box or a zero means the line is not returned', () => {
    expect(returnPick('', pieces)).toEqual({ text: '', quantity: 0, status: 'none' });
    expect(returnPick('0', pieces)).toEqual({ text: '', quantity: 0, status: 'none' });
    expect(returnPick('x', pieces)).toEqual({ text: '', quantity: 0, status: 'none' });
  });
});

describe('returnPick: weighed goods are typed in kg / litres, stored in grams / ml', () => {
  it.each([
    ['1', 1000],
    ['1.5', 1500],
    ['0.25', 250],
    ['1.500', 1500],
  ])('"%s" -> %d base units', (text, quantity) => {
    expect(returnPick(text, weighed)).toEqual({ text, quantity, status: 'ok' });
  });

  it('keeps only digits and a dot in the box', () => {
    expect(returnPick('1,5', weighed)).toEqual({ text: '15', quantity: 0, status: 'tooMuch' });
    expect(returnPick('1.5 kg', weighed)).toEqual({ text: '1.5', quantity: 1500, status: 'ok' });
  });

  it('never rewrites what the cashier is still typing: more than is left is flagged, not capped', () => {
    expect(returnPick('2', weighed)).toEqual({ text: '2', quantity: 0, status: 'tooMuch' });
    expect(returnPick('1.501', weighed)).toEqual({ text: '1.501', quantity: 0, status: 'tooMuch' });
  });

  it('exactly what is left is fine', () => {
    expect(returnPick('1.5', weighed)).toEqual({ text: '1.5', quantity: 1500, status: 'ok' });
  });

  it('a half-typed or over-precise number is invalid, so the return cannot be confirmed by mistake', () => {
    expect(returnPick('1.', weighed)).toEqual({ text: '1.', quantity: 0, status: 'invalid' });
    expect(returnPick('.5', weighed)).toEqual({ text: '.5', quantity: 0, status: 'invalid' });
    expect(returnPick('1.2345', weighed)).toEqual({
      text: '1.2345',
      quantity: 0,
      status: 'invalid',
    });
    expect(returnPick('1.2.3', weighed)).toEqual({ text: '1.2.3', quantity: 0, status: 'invalid' });
  });

  it('empty and zero mean the line is not returned', () => {
    expect(returnPick('', weighed)).toEqual({ text: '', quantity: 0, status: 'none' });
    expect(returnPick('0', weighed)).toEqual({ text: '0', quantity: 0, status: 'none' });
    expect(returnPick('0.000', weighed)).toEqual({ text: '0.000', quantity: 0, status: 'none' });
  });

  it('the quantity is always a whole number of base units', () => {
    const q = returnPick('0.333', weighed).quantity;
    expect(Number.isInteger(q)).toBe(true);
    expect(q).toBe(333);
  });
});

describe('returnPickList / hasBadPick: what goes to the service', () => {
  it('sends only the boxes holding a usable quantity, in base units', () => {
    const picks = {
      a: returnPick('2', pieces),
      b: returnPick('0.5', weighed),
      c: returnPick('', pieces),
      d: returnPick('9', weighed),
    };
    expect(returnPickList(picks)).toEqual([
      { lineId: 'a', quantity: 2 },
      { lineId: 'b', quantity: 500 },
    ]);
  });

  it('flags a return that has a box the cashier must fix first', () => {
    expect(hasBadPick({ a: returnPick('2', pieces), b: returnPick('0.5', weighed) })).toBe(false);
    expect(hasBadPick({ a: returnPick('2', pieces), b: returnPick('9', weighed) })).toBe(true);
    expect(hasBadPick({ b: returnPick('1.', weighed) })).toBe(true);
    expect(hasBadPick({})).toBe(false);
  });
});

describe('remainingText: the limit shown in the box', () => {
  it('reads in pieces or in kg', () => {
    expect(remainingText(pieces)).toBe('3');
    expect(remainingText(weighed)).toBe('1.5');
    expect(remainingText({ unitScale: 1000, remainingQty: 250 })).toBe('0.25');
  });
});
