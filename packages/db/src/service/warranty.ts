import {
  ServiceError,
  WARRANTY_KINDS,
  type ExpiringWarranty,
  type Warranty,
  type WarrantyApi,
  type WarrantyState,
  type WarrantyStatus,
} from '@pos/shared';
import { WriteBatch } from './batch';
import { requirePermission, type Ctx } from './deps';
import { guardApi, intIn, invalid, optText } from './errors';
import { mapRow, phoneLabel, toPhoneView, type Raw } from './mappers';
import { loadShop } from './meta';
import { PHONE_VIEW_SQL } from './queries';
import { insertRec } from './rec';

const DAY_MS = 86_400_000;
const MAX_WARRANTY_DAYS = 3_650;

/** Active / expired relative to `now`; a returned sale voids its warranties. */
function statusOf(w: Warranty, now: number, returned: boolean): WarrantyStatus {
  const state: WarrantyState = returned ? 'void' : now >= w.endsAt ? 'expired' : 'active';
  return {
    warranty: w,
    state,
    daysLeft: state === 'active' ? Math.ceil((w.endsAt - now) / DAY_MS) : 0,
  };
}

/** True when a return / void against `saleId` took this unit back. */
async function unitReturned(ctx: Ctx, saleId: string, phoneUnitId: string): Promise<boolean> {
  const rows = await ctx.driver.query(
    `SELECT 1 AS x FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
     WHERE s.original_sale_id = ? AND sl.phone_unit_id = ? LIMIT 1`,
    [saleId, phoneUnitId],
  );
  return rows.length > 0;
}

// SQL twin of unitReturned for list queries (w = warranties alias).
const NOT_RETURNED = `NOT EXISTS (
  SELECT 1 FROM sale_lines rl JOIN sales rs ON rs.id = rl.sale_id
  WHERE rs.original_sale_id = w.sale_id AND rl.phone_unit_id = w.phone_unit_id)`;

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function createWarrantyApi(ctx: Ctx): WarrantyApi {
  return guardApi<WarrantyApi>({
    async register(i) {
      const session = requirePermission(ctx, 'sell');
      if (!(WARRANTY_KINDS as readonly string[]).includes(i.kind))
        throw invalid('kind', 'Unknown warranty kind');
      const note = optText(i.note, 'note', 200);
      return ctx.lock(async () => {
        const sale = (
          await ctx.driver.query<{ id: string; kind: string; created_at: number }>(
            'SELECT id, kind, created_at FROM sales WHERE id = ?',
            [i.saleId],
          )
        )[0];
        if (sale === undefined)
          throw new ServiceError('NOT_FOUND', 'Sale not found', { id: i.saleId });
        if (sale.kind !== 'sale')
          throw invalid('saleId', 'Warranty can only be added to a sale invoice');
        const onSale = await ctx.driver.query(
          'SELECT 1 AS x FROM sale_lines WHERE sale_id = ? AND phone_unit_id = ?',
          [i.saleId, i.phoneUnitId],
        );
        if (onSale.length === 0) throw invalid('phoneUnitId', 'This phone is not on that sale');
        if (await unitReturned(ctx, i.saleId, i.phoneUnitId))
          throw invalid('phoneUnitId', 'This phone was returned');

        const hasDays = i.days !== undefined;
        const hasEnd = i.endsAt !== undefined;
        if (hasDays === hasEnd) throw invalid('days', 'Give either days or an end date');
        const startsAt = sale.created_at;
        const endsAt = hasDays
          ? startsAt + intIn(i.days, 'days', 1, MAX_WARRANTY_DAYS) * DAY_MS
          : intIn(i.endsAt, 'endsAt', startsAt + 1, Number.MAX_SAFE_INTEGER);

        const dup = await ctx.driver.query(
          'SELECT 1 AS x FROM warranties WHERE sale_id = ? AND phone_unit_id = ? AND kind = ?',
          [i.saleId, i.phoneUnitId, i.kind],
        );
        if (dup.length > 0)
          throw new ServiceError('DUPLICATE', `A ${i.kind} warranty already exists`, {
            field: 'kind',
          });

        const shop = await loadShop(ctx.driver);
        const at = ctx.clock();
        const rec: Warranty = {
          id: ctx.newId(),
          phoneUnitId: i.phoneUnitId,
          saleId: i.saleId,
          kind: i.kind,
          startsAt,
          endsAt,
          note,
          createdBy: session.user.id,
          createdAt: at,
        };
        const b = new WriteBatch(ctx.newId, at);
        insertRec(b, 'warranties', 'warranty', rec);
        await ctx.assertCanSell({ action: 'warranty', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
        return rec;
      });
    },

    async lookup(imeiOrSerial) {
      requirePermission(ctx, 'sell');
      const key = typeof imeiOrSerial === 'string' ? imeiOrSerial.trim() : '';
      if (key === '') throw invalid('imeiOrSerial', 'Enter an IMEI or serial');
      const unitRow = (
        await ctx.driver.query<Raw>(
          `${PHONE_VIEW_SQL} WHERE pu.imei1 = ? OR pu.imei2 = ? OR lower(pu.serial) = lower(?)`,
          [key, key, key],
        )
      )[0];
      if (unitRow === undefined)
        throw new ServiceError('NOT_FOUND', 'No phone with this IMEI / serial', { q: key });
      const unit = toPhoneView(unitRow);

      // The latest sale of the unit (a returned phone may be sold again with new warranties).
      const sale = (
        await ctx.driver.query<Raw>(
          `SELECT s.id, s.invoice_no, s.created_at, s.customer_id, c.name AS customer_name
           FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id LEFT JOIN customers c ON c.id = s.customer_id
           WHERE sl.phone_unit_id = ? AND s.kind = 'sale'
           ORDER BY s.created_at DESC, s.seq DESC LIMIT 1`,
          [unit.unit.id],
        )
      )[0];
      if (sale === undefined) return { unit, sale: null, warranties: [] };
      const saleId = String(sale.id);
      const returned = await unitReturned(ctx, saleId, unit.unit.id);
      const rows = await ctx.driver.query<Raw>(
        'SELECT * FROM warranties WHERE sale_id = ? AND phone_unit_id = ? ORDER BY kind',
        [saleId, unit.unit.id],
      );
      const now = ctx.clock();
      return {
        unit,
        sale: {
          saleId,
          invoiceNo: String(sale.invoice_no),
          soldAt: Number(sale.created_at),
          customerId: strOrNull(sale.customer_id),
          customerName: strOrNull(sale.customer_name),
          returned,
        },
        warranties: rows.map((r) => statusOf(mapRow<Warranty>(r), now, returned)),
      };
    },

    async listExpiring(days) {
      requirePermission(ctx, 'sell');
      const span = intIn(days, 'days', 0, MAX_WARRANTY_DAYS);
      const now = ctx.clock();
      const rows = await ctx.driver.query<Raw>(
        `SELECT w.*, s.invoice_no, c.name AS customer_name, c.phone AS customer_phone,
                pu.imei1, pu.serial AS unit_serial, pu.colour AS unit_colour, pu.ram_gb, pu.storage_gb,
                p.brand, p.name AS product_name
         FROM warranties w
         JOIN sales s ON s.id = w.sale_id
         JOIN phone_units pu ON pu.id = w.phone_unit_id
         JOIN products p ON p.id = pu.product_id
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE w.ends_at > ? AND w.ends_at <= ? AND ${NOT_RETURNED}
         ORDER BY w.ends_at, w.id`,
        [now, now + span * DAY_MS],
      );
      return rows.map((r): ExpiringWarranty => {
        const warranty = mapRow<Warranty>({
          id: r.id,
          phone_unit_id: r.phone_unit_id,
          sale_id: r.sale_id,
          kind: r.kind,
          starts_at: r.starts_at,
          ends_at: r.ends_at,
          note: r.note,
          created_by: r.created_by,
          created_at: r.created_at,
        });
        return {
          status: statusOf(warranty, now, false),
          unitLabel: phoneLabel(
            { brand: String(r.brand), name: String(r.product_name) },
            {
              colour: strOrNull(r.unit_colour),
              ramGb: r.ram_gb === null ? null : Number(r.ram_gb),
              storageGb: r.storage_gb === null ? null : Number(r.storage_gb),
            },
          ),
          imei: strOrNull(r.imei1),
          serial: strOrNull(r.unit_serial),
          invoiceNo: String(r.invoice_no),
          customerName: strOrNull(r.customer_name),
          customerPhone: strOrNull(r.customer_phone),
        };
      });
    },
  });
}
