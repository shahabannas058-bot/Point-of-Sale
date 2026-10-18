import { z } from 'zod';

/**
 * Stock and sale quantities are always whole numbers in the item's BASE unit: pieces, or grams / millilitres for
 * loose goods. `unitScale` says how many base units make one priced unit: 1 for pieces, 1000 for kg and litres.
 * Prices (sale, cost, unit_price) are per priced unit, e.g. paisa per kg. See ADR-0008.
 */
export const UnitScaleSchema = z.union([z.literal(1), z.literal(1000)]);
export type UnitScale = z.infer<typeof UnitScaleSchema>;

export const UNIT_LABELS = ['pcs', 'kg', 'L'] as const;
export const UnitLabelSchema = z.enum(UNIT_LABELS);
export type UnitLabel = z.infer<typeof UnitLabelSchema>;

export const unitScaleFor = (label: UnitLabel): UnitScale => (label === 'pcs' ? 1 : 1000);

/** Largest single quantity (base units) the service accepts: 1,000,000 pieces, or 100,000 kg / litres. */
export const maxQuantity = (scale: UnitScale): number => (scale === 1 ? 1_000_000 : 100_000_000);
/** Upper bound used before the item (and so its scale) is known. */
export const MAX_QUANTITY_ANY = 100_000_000;

/**
 * quantity * unitPrice / unitScale, rounded half away from zero (same rule as the SQL CHECK on sale_lines and
 * the C# port). Exact: the product is computed with BigInt. The result may exceed the safe-integer range;
 * callers that need a Paisa must validate it.
 */
export function lineGross(quantity: number, unitPrice: number, unitScale: UnitScale = 1): number {
  if (unitScale === 1) return quantity * unitPrice;
  const product = BigInt(quantity) * BigInt(unitPrice);
  const scale = BigInt(unitScale);
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const rounded = (magnitude + scale / 2n) / scale;
  const out = Number(negative ? -rounded : rounded);
  return out === 0 ? 0 : out;
}

/** 1500 grams with scale 1000 -> "1.5". Pieces (scale 1) -> "3". Trailing zeros are trimmed. */
export function formatQuantity(quantity: number, unitScale: UnitScale = 1): string {
  if (unitScale === 1) return String(quantity);
  const abs = Math.abs(quantity);
  const whole = Math.floor(abs / unitScale);
  const frac = String(abs % unitScale)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${quantity < 0 ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

/**
 * "1.5" -> 1500 (scale 1000), "3" -> 3 (scale 1). String parsing only, never a float multiply.
 * Returns null for anything that is not a plain non-negative number with at most 3 decimals (0 decimals for pieces).
 */
export function parseQuantity(input: string, unitScale: UnitScale = 1): number | null {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(input.trim());
  if (m === null) return null;
  const whole = m[1] ?? '0';
  const frac = m[2] ?? '';
  if (unitScale === 1) return frac === '' ? Number(whole) : null;
  const value = Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
  return Number.isSafeInteger(value) ? value : null;
}
