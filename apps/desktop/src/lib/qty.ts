import {
  formatQuantity,
  lineGross,
  parseQuantity,
  type AccessoryVariant,
  type UnitLabel,
  type UnitScale,
} from '@pos/shared';

/** "3" for pieces, "1.25 kg" for goods sold by weight or volume. `quantity` is in base units (grams / ml). */
export const qtyText = (quantity: number, scale: UnitScale, unit: UnitLabel): string =>
  scale === 1 ? String(quantity) : `${formatQuantity(quantity, scale)} ${unit}`;

/** The unit as a word: kg, litre, or `pieceWord` (the language's word for a piece) for items counted one by one. */
export const unitWord = (unit: UnitLabel, pieceWord: string): string =>
  unit === 'pcs' ? pieceWord : unit === 'L' ? 'litre' : unit;

/** A stock number with its unit always written: "3 piece", "0.5 kg", "2 litre". `quantity` is in base units. */
export const qtyWithUnit = (
  quantity: number,
  scale: UnitScale,
  unit: UnitLabel,
  pieceWord: string,
): string => `${formatQuantity(quantity, scale)} ${unitWord(unit, pieceWord)}`;

/**
 * The stock change for "add" or "remove" and a plain number the cashier typed ("2", or "0.5" for half a kg): positive
 * to add, negative to remove, in base units. Null when it is not a usable amount (empty, zero, a sign, text, or a
 * fraction of a piece), so the box never needs a minus sign.
 */
export function adjustmentDelta(
  mode: 'add' | 'remove',
  text: string,
  scale: UnitScale,
): number | null {
  const amount = parseQuantity(text.trim(), scale);
  if (amount === null || amount <= 0) return null;
  return mode === 'add' ? amount : -amount;
}

/** A stock number in the item's own unit: "3" for a piece item, "1.25 kg" for a loose one. */
export const variantQtyText = (
  quantity: number,
  v: Pick<AccessoryVariant, 'unitScale' | 'unitLabel'>,
): string => qtyText(quantity, v.unitScale, v.unitLabel);

/** What the + and - keys change: one piece, or 250 g for goods sold by weight. */
export const qtyStep = (scale: UnitScale): number => (scale === 1 ? 1 : 250);

/**
 * Like parseQuantity but allows one leading minus ("-0.5" -> -500), for stock adjustments.
 * Returns null for anything else, including "+2", "-" and fractions of a piece. Never -0.
 */
export function parseSignedQuantity(input: string, scale: UnitScale): number | null {
  const text = input.trim();
  const negative = text.startsWith('-');
  const magnitude = parseQuantity(negative ? text.slice(1) : text, scale);
  if (magnitude === null) return null;
  return negative && magnitude !== 0 ? -magnitude : magnitude;
}

/** Suffix printed after a price: nothing for pieces, "/kg" for goods sold by weight. */
export const perUnit = (scale: UnitScale, unit: UnitLabel): string =>
  scale === 1 ? '' : `/${unit}`;

/** When only the scale is known (an invoice line has no label): weighed goods are shown in kg. */
export const labelFor = (scale: UnitScale): UnitLabel => (scale === 1 ? 'pcs' : 'kg');

/**
 * How much `amount` (paisa) buys at `unitPrice` (paisa per kg / litre / piece), in base units, to the nearest one:
 * Rs 150 at Rs 150/kg is 1000 g, Rs 100 is 667 g (666.67). Null when it buys less than half a base unit, or the
 * inputs are not usable. Exact integer arithmetic (BigInt), the same rounding direction as lineGross().
 */
export function quantityForAmount(
  amount: number,
  unitPrice: number,
  scale: UnitScale,
): number | null {
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(unitPrice)) return null;
  if (amount <= 0 || unitPrice <= 0) return null;
  const price = BigInt(unitPrice);
  const q = (2n * BigInt(amount) * BigInt(scale) + price) / (2n * price); // round half up
  if (q < 1n || q > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(q);
}

export interface WeightForAmount {
  /** Base units (grams / millilitres). */
  quantity: number;
  /** Paisa taken off the line so that its total is exactly the typed amount. */
  discount: number;
}

/**
 * The cashier types what the customer pays and the line total must be exactly that: take the smallest weight that
 * costs at least the amount, and write the few paisa over off as a discount (Rs 100 at Rs 150/kg: 667 g costs
 * Rs 100.05, discount 5 paisa, total Rs 100). The round-off may never be more than 1 % of the price; for a tiny
 * amount it would no longer be a round-off, so the nearest weight is used with no discount (so no approval needed).
 */
export function weightForAmount(
  amount: number,
  unitPrice: number,
  scale: UnitScale,
): WeightForAmount | null {
  const nearest = quantityForAmount(amount, unitPrice, scale);
  if (nearest === null) return null;
  const price = BigInt(unitPrice);
  const exactBig = (BigInt(amount) * BigInt(scale) + price - 1n) / price; // rounded up
  if (exactBig > BigInt(Number.MAX_SAFE_INTEGER)) return { quantity: nearest, discount: 0 };
  const quantity = Number(exactBig);
  const gross = lineGross(quantity, unitPrice, scale);
  const discount = gross - amount;
  if (discount < 0 || discount * 100 > gross) return { quantity: nearest, discount: 0 };
  return { quantity, discount };
}

/** Base-unit amounts of the quick buttons next to a weight box: 250, 500 and 1000 g (or ml). */
export const QUICK_AMOUNTS = [250, 500, 1000] as const;

/** "250 g", "500 g", "1 kg" (or "250 ml" ... "1 L"). */
export function quickLabel(amount: number, unit: UnitLabel): string {
  const small = unit === 'L' ? 'ml' : 'g';
  return amount >= 1000 ? `${amount / 1000} ${unit}` : `${amount} ${small}`;
}
