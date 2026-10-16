/** snake_case DB row -> camelCase contract object. Booleans (is_active) and JSON are mapped by the repository layer. */
export function camelizeKeys<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()),
      v,
    ]),
  ) as T;
}
