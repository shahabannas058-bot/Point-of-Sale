/**
 * SQL for quantity * price / unit_scale, rounded half away from zero: the same rule as the sale_lines CHECK and
 * lineGross() in @pos/shared. `price` is a column of the aliased `l` (sale_lines).
 */
export const grossSql = (price: string): string =>
  `CASE WHEN l.quantity * ${price} >= 0
     THEN (l.quantity * ${price} + l.unit_scale / 2) / l.unit_scale
     ELSE -((-(l.quantity * ${price}) + l.unit_scale / 2) / l.unit_scale) END`;

/** The weight round-off part of a sale line's discount (SQL twin of roundOffOf in @pos/shared), 0 for pieces. */
export const ROUND_OFF_SQL = `CASE WHEN l.unit_scale > 1 AND l.discount_amount <> 0
     AND abs(l.discount_amount) * l.unit_scale * 2 <= l.unit_price * 2 + l.unit_scale
     THEN l.discount_amount ELSE 0 END`;
