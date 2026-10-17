import {
  WARRANTY_KINDS,
  type ExpiringWarranty,
  type Id,
  type PosWarrantyApi,
  type Warranty,
  type WarrantyKind,
  type WarrantyStatus,
} from '@pos/shared';
import type { SqlValue } from '../driver';
import {
  emit,
  insert,
  one,
  phoneLabel,
  phoneViews,
  q,
  requirePerm,
  write,
  type Ctx,
} from './context';
import { fail, intIn, invalid, optText } from './errors';

type Row = Record<string, SqlValue>;

const DAY_MS = 86_400_000;
const MAX_WARRANTY_DAYS = 3_650;

const str = (v: SqlValue | undefined): string | null =>
  v === null || v === undefined ? null : String(v);

const toWarranty = (r: Row): Warranty => ({
  id: String(r.id),
  phoneUnitId: String(r.phone_unit_id),
  saleId: String(r.sale_id),
  kind: String(r.kind) as WarrantyKind,
  startsAt: Number(r.starts_at),
  endsAt: Number(r.ends_at),
  note: str(r.note),
  createdBy: String(r.created_by),
  createdAt: Number(r.created_at),
});

/** Active / expired relative to `now`; a returned sale voids its warranties. */
function statusOf(w: Warranty, now: number, returned: boolean): WarrantyStatus {
  if (returned) return { warranty: w, state: 'void', daysLeft: 0 };
  if (now >= w.endsAt) return { warranty: w, state: 'expired', daysLeft: 0 };
  return { warranty: w, state: 'active', daysLeft: Math.ceil((w.endsAt - now) / DAY_MS) };
}

/** True when a return / void against `saleId` took this unit back. */
async function unitReturned(ctx: Ctx, saleId: Id, phoneUnitId: Id): Promise<boolean> {
  const r = await one(
    ctx,
    `SELECT 1 AS x FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
     WHERE s.original_sale_id = ? AND sl.phone_unit_id = ? LIMIT 1`,
    [saleId, phoneUnitId],
  );
  return r !== undefined;
}

// SQL twin of unitReturned for list queries (w = warranties alias).
const NOT_RETURNED = `NOT EXISTS (
  SELECT 1 FROM sale_lines rl JOIN sales rs ON rs.id = rl.sale_id
  WHERE rs.original_sale_id = w.sale_id AND rl.phone_unit_id = w.phone_unit_id)`;

export function warrantyApi(ctx: Ctx): PosWarrantyApi {
  return {
    register: (i) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'sell');
        if (!(WARRANTY_KINDS as readonly string[]).includes(i.kind))
          invalid('kind', 'Unknown warranty kind');
        const sale = await one(ctx, 'SELECT id, kind, created_at FROM sales WHERE id = ?', [
          i.saleId,
        ]);
        if (!sale) return fail('NOT_FOUND', 'Sale not found', { id: i.saleId });
        if (sale.kind !== 'sale') invalid('saleId', 'Warranty can only be added to a sale invoice');
        const onSale = await one(
          ctx,
          'SELECT 1 AS x FROM sale_lines WHERE sale_id = ? AND phone_unit_id = ?',
          [i.saleId, i.phoneUnitId],
        );
        if (!onSale) invalid('phoneUnitId', 'This phone is not on that sale');
        if (await unitReturned(ctx, i.saleId, i.phoneUnitId))
          invalid('phoneUnitId', 'This phone was returned');

        const hasDays = i.days !== undefined && i.days !== null;
        const hasEnd = i.endsAt !== undefined && i.endsAt !== null;
        if (hasDays === hasEnd) invalid('days', 'Give either days or an end date');
        const startsAt = Number(sale.created_at);
        const endsAt = hasDays
          ? startsAt + intIn(i.days, 'days', 1, MAX_WARRANTY_DAYS) * DAY_MS
          : intIn(i.endsAt, 'endsAt', startsAt + 1, Number.MAX_SAFE_INTEGER);

        const dup = await one(
          ctx,
          'SELECT 1 AS x FROM warranties WHERE sale_id = ? AND phone_unit_id = ? AND kind = ?',
          [i.saleId, i.phoneUnitId, i.kind],
        );
        if (dup) fail('DUPLICATE', `A ${i.kind} warranty already exists`, { field: 'kind' });

        const t = ctx.now();
        const id = ctx.newId();
        const row = {
          id,
          phone_unit_id: i.phoneUnitId,
          sale_id: i.saleId,
          kind: i.kind,
          starts_at: startsAt,
          ends_at: endsAt,
          note: optText(i.note, 'note', 200),
          created_by: s.user.id,
          created_at: t,
        };
        await write(ctx, [insert('warranties', row), emit(ctx, 'warranty', id, row, t)]);
        return toWarranty(row);
      }),

    async lookup(imeiOrSerial) {
      requirePerm(ctx, 'sell');
      const key = typeof imeiOrSerial === 'string' ? imeiOrSerial.trim() : '';
      if (!key) return invalid('imeiOrSerial', 'Enter an IMEI or serial');
      const [unit] = await phoneViews(
        ctx,
        'WHERE pu.imei1 = ? OR pu.imei2 = ? OR lower(pu.serial) = lower(?)',
        [key, key, key],
      );
      if (!unit) return fail('NOT_FOUND', 'No phone with this IMEI / serial', { q: key });

      // The latest sale of the unit (a returned phone may be sold again with new warranties).
      const sale = await one(
        ctx,
        `SELECT s.id, s.invoice_no, s.created_at, s.customer_id, c.name AS customer_name
         FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id LEFT JOIN customers c ON c.id = s.customer_id
         WHERE sl.phone_unit_id = ? AND s.kind = 'sale'
         ORDER BY s.created_at DESC, s.seq DESC LIMIT 1`,
        [unit.unit.id],
      );
      if (!sale) return { unit, sale: null, warranties: [] };
      const saleId = String(sale.id);
      const returned = await unitReturned(ctx, saleId, unit.unit.id);
      const rows = await q(
        ctx,
        'SELECT * FROM warranties WHERE sale_id = ? AND phone_unit_id = ? ORDER BY kind',
        [saleId, unit.unit.id],
      );
      const now = ctx.now();
      return {
        unit,
        sale: {
          saleId,
          invoiceNo: String(sale.invoice_no),
          soldAt: Number(sale.created_at),
          customerId: str(sale.customer_id),
          customerName: str(sale.customer_name),
          returned,
        },
        warranties: rows.map((r) => statusOf(toWarranty(r), now, returned)),
      };
    },

    async listExpiring(days) {
      requirePerm(ctx, 'sell');
      const span = intIn(days, 'days', 0, MAX_WARRANTY_DAYS);
      const now = ctx.now();
      const rows = await q(
        ctx,
        `SELECT w.*, s.invoice_no, c.name AS customer_name, c.phone AS customer_phone,
                pu.imei1, pu.serial, pu.colour, pu.ram_gb, pu.storage_gb, p.brand, p.name AS product_name
         FROM warranties w
         JOIN sales s ON s.id = w.sale_id
         JOIN phone_units pu ON pu.id = w.phone_unit_id
         JOIN products p ON p.id = pu.product_id
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE w.ends_at > ? AND w.ends_at <= ? AND ${NOT_RETURNED}
         ORDER BY w.ends_at, w.id`,
        [now, now + span * DAY_MS],
      );
      return rows.map((r): ExpiringWarranty => ({
        status: statusOf(toWarranty(r), now, false),
        unitLabel: phoneLabel(
          String(r.brand),
          String(r.product_name),
          str(r.colour),
          r.ram_gb === null ? null : Number(r.ram_gb),
          r.storage_gb === null ? null : Number(r.storage_gb),
        ),
        imei: str(r.imei1),
        serial: str(r.serial),
        invoiceNo: String(r.invoice_no),
        customerName: str(r.customer_name),
        customerPhone: str(r.customer_phone),
      }));
    },
  };
}
