import { formatQuantity, parseQuantity, type ReturnableLine } from '@pos/shared';

type Line = Pick<ReturnableLine, 'unitScale' | 'remainingQty'>;

/** One return-quantity box: what it shows and what it means. */
export interface ReturnPick {
  /** What the box shows. */
  text: string;
  /** Base units (pieces, or grams / ml for weighed goods); 0 unless `status` is 'ok'. */
  quantity: number;
  /** 'none': nothing to return from this line; 'ok': `quantity` goes back; the other two block the return. */
  status: 'none' | 'ok' | 'invalid' | 'tooMuch';
}

const NONE: ReturnPick = { text: '', quantity: 0, status: 'none' };

/**
 * The box after a keystroke. Pieces behave as they always did: digits only, held at what is left to return.
 * Weighed goods are typed in kg / litres like on the billing screen ("1.25"), so the box takes digits and a dot,
 * and more than is left is flagged as `tooMuch` rather than rewriting what the cashier is still typing.
 * `quantity` is always a whole number of base units; parseQuantity() does the string arithmetic.
 */
export function returnPick(raw: string, line: Line): ReturnPick {
  if (line.unitScale === 1) {
    const n = Math.min(line.remainingQty, Number(raw.replace(/\D/g, '') || '0'));
    return n <= 0 ? NONE : { text: String(n), quantity: n, status: 'ok' };
  }
  const text = raw.replace(/[^\d.]/g, '');
  if (text === '') return NONE;
  const q = parseQuantity(text, line.unitScale);
  if (q === null) return { text, quantity: 0, status: 'invalid' };
  if (q === 0) return { text, quantity: 0, status: 'none' };
  if (q > line.remainingQty) return { text, quantity: 0, status: 'tooMuch' };
  return { text, quantity: q, status: 'ok' };
}

/** The lines to send to the service: every box holding a usable quantity, in base units. */
export const returnPickList = (
  picks: Record<string, ReturnPick>,
): { lineId: string; quantity: number }[] =>
  Object.entries(picks)
    .filter(([, p]) => p.status === 'ok')
    .map(([lineId, p]) => ({ lineId, quantity: p.quantity }));

/** True when some box holds something that cannot be returned, so the return may not be confirmed yet. */
export const hasBadPick = (picks: Record<string, ReturnPick>): boolean =>
  Object.values(picks).some((p) => p.status === 'invalid' || p.status === 'tooMuch');

/** How much of a line can still go back, in the unit the cashier types: "3" pieces, or "1.5" (kg / L). */
export const remainingText = (line: Line): string =>
  formatQuantity(line.remainingQty, line.unitScale);
