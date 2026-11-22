import type { Item, Product, ItemView } from '@pos/shared';
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

export function itemLabel(
  product: Pick<Product, 'brand' | 'name'>,
  item: Pick<Item, 'model' | 'colour'>,
): string {
  const extra = join([item.model, item.colour], ', ');
  return join([`${product.brand} ${product.name}`, extra === '' ? null : `(${extra})`], ' ');
}

export function toItemView(row: Raw): ItemView {
  const { item: itemRow, product, onHand } = split(row);
  const item = mapRow<Item>(itemRow);
  const prod = mapRow<Product>(product);
  return {
    item,
    product: prod,
    onHand,
    lowStock: onHand <= item.reorderLevel,
    label: itemLabel(prod, item),
  };
}
