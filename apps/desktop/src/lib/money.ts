import { applyPercentDiscount, paisa, percentToBps, rupeesToPaisa } from '@pos/core';
import type { Paisa } from '@pos/shared';

export interface FormatRsOptions {
  /** 'lakh' = 1,23,45,678 (South Asian); 'thousand' = 12,345,678. */
  grouping?: 'lakh' | 'thousand';
  symbol?: string | null;
  /** 'auto' drops ".00"; 'always' shows two decimals; 'never' truncates paisa. */
  decimals?: 'auto' | 'always' | 'never';
}

/** Groups a string of digits using integer/string logic only (never Intl). */
export function groupDigits(digits: string, grouping: 'lakh' | 'thousand' = 'lakh'): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const size = grouping === 'lakh' ? 2 : 3;
  const parts: string[] = [];
  while (rest.length > size) {
    parts.unshift(rest.slice(-size));
    rest = rest.slice(0, -size);
  }
  if (rest.length > 0) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

/**
 * Integer paisa -> display string. All maths is integer: rupees = trunc(abs / 100), paise = abs % 100.
 * 1234567800 -> "Rs 1,23,45,678"; 150050 -> "Rs 1,500.50"; -250 -> "-Rs 2.50".
 */
export function formatRs(p: number, opts: FormatRsOptions = {}): string {
  const { grouping = 'lakh', symbol = 'Rs', decimals = 'auto' } = opts;
  if (!Number.isSafeInteger(p)) return '—';
  const abs = Math.abs(p);
  const rupees = Math.trunc(abs / 100);
  const paise = abs % 100;
  let body = groupDigits(String(rupees), grouping);
  if (decimals === 'always' || (decimals === 'auto' && paise !== 0)) {
    body += `.${String(paise).padStart(2, '0')}`;
  }
  const sign = p < 0 ? '-' : '';
  return symbol ? `${sign}${symbol} ${body}` : `${sign}${body}`;
}

/** Plain number (no symbol) with lakh grouping, for tables where the column header says Rs. */
export const formatAmount = (p: number, decimals: FormatRsOptions['decimals'] = 'auto'): string =>
  formatRs(p, { symbol: null, decimals });

/** Parses user input like "1,500.5" into paisa. Returns null when invalid or negative. */
export function parseRupees(input: string): Paisa | null {
  const s = input.trim().replace(/,/g, '');
  if (s === '' || s.startsWith('-')) return null;
  try {
    return rupeesToPaisa(s);
  } catch {
    return null;
  }
}

/** Paisa -> editable input string ("1500" or "1500.5"), used to prefill fields. */
export function paisaToInput(p: number): string {
  const abs = Math.abs(p);
  const rupees = Math.trunc(abs / 100);
  const paise = abs % 100;
  const frac = paise === 0 ? '' : `.${String(paise).padStart(2, '0').replace(/0$/, '')}`;
  return `${p < 0 ? '-' : ''}${rupees}${frac}`;
}

/** "12.5" percent of a gross amount -> discount in paisa (half-up, via core). Null when invalid or > 100%. */
export function percentDiscount(gross: Paisa, percentInput: string): Paisa | null {
  const n = Number(percentInput.trim());
  if (percentInput.trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) return null;
  return applyPercentDiscount(gross, percentToBps(n)).discount;
}

export { paisa };
