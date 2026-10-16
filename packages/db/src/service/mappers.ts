import type { AccessoryVariant, PhoneUnit, PhoneUnitView, Product, VariantView } from '@pos/shared';
import { camelizeKeys } from '../rows';

export type Raw = Record<string, unknown>;

/** snake_case row -> camelCase object; is_active (0/1) -> boolean. Cast to the contract type without Zod. */
export function mapRow<T>(row: Raw): T {
  const o = camelizeKeys<Raw>(row);
  if ('isActive' in o) o.isActive = o.isActive === 1 || o.isActive === true;
  return o as T;
}

export const mapRows = <T>(rows: readonly Raw[]): T[] => rows.map((r) => mapRow<T>(r));

/** Splits a joined row: keys starting with `p_` belong to the product, the rest (minus on_hand) to the item. */
function split(row: Raw): { item: Raw; product: Raw; onHand: number } {
  const item: Raw = {};
  const product: Raw = { id: row.product_id };
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('p_')) product[k.slice(2)] = v;
    else if (k !== 'on_hand') item[k] = v;
  }
  return { item, product, onHand: Number(row.on_hand ?? 0) };
}

const join = (parts: (string | null | undefined)[], sep: string): string =>
  parts.filter((p): p is string => typeof p === 'string' && p !== '').join(sep);

export function phoneLabel(
  product: Pick<Product, 'brand' | 'name'>,
  unit: Pick<PhoneUnit, 'colour' | 'ramGb' | 'storageGb'>,
): string {
  const mem =
    unit.ramGb !== null && unit.storageGb !== null
      ? `${unit.ramGb}/${unit.storageGb}GB`
      : unit.storageGb !== null
        ? `${unit.storageGb}GB`
        : null;
  const extra = join([unit.colour, mem], ', ');
  return join([`${product.brand} ${product.name}`, extra === '' ? null : `(${extra})`], ' ');
}

export function variantLabel(
  product: Pick<Product, 'brand' | 'name'>,
  variant: Pick<AccessoryVariant, 'model' | 'colour'>,
): string {
  const extra = join([variant.model, variant.colour], ', ');
  return join([`${product.brand} ${product.name}`, extra === '' ? null : `(${extra})`], ' ');
}

export function toPhoneView(row: Raw): PhoneUnitView {
  const { item, product, onHand } = split(row);
  const unit = mapRow<PhoneUnit>(item);
  const prod = mapRow<Product>(product);
  return { unit, product: prod, inStock: onHand > 0, label: phoneLabel(prod, unit) };
}

export function toVariantView(row: Raw): VariantView {
  const { item, product, onHand } = split(row);
  const variant = mapRow<AccessoryVariant>(item);
  const prod = mapRow<Product>(product);
  return {
    variant,
    product: prod,
    onHand,
    lowStock: onHand <= variant.reorderLevel,
    label: variantLabel(prod, variant),
  };
}
