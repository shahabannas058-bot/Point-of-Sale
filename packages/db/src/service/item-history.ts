import type {
  ItemHistoryEntry,
  ItemHistoryKind,
  ItemHistoryPage,
  ItemHistoryQuery,
  ItemHistoryRef,
  ItemRef,
  Paisa,
} from '@pos/shared';
import { canDo, type Ctx } from './deps';
import { intIn, invalid } from './errors';
import { loadPhoneUnitRec, loadVariantRec } from './queries';
import type { SqlValue } from '../types';

/*
 * Item history ("Ctrl+H" in Abuzar): every stock movement of one item, newest first, with the on-hand
 * balance right after each row. The running balance is a window SUM over the item's WHOLE ledger
 * (ordered oldest -> newest by created_at, id); the from/to window and the cursor are applied on top of
 * that inner query, so a filtered page still shows true balances. Each row resolves what it belonged to:
 * the sale / return invoice and customer, the purchase's supplier and reference, the repair ticket
 * (repair spare parts are 'adjustment' movements linked through repair_parts.stock_movement_id),
 * the batch, and the user who did it.
 */

export const ITEM_HISTORY_DEFAULT_LIMIT = 200;
export const ITEM_HISTORY_MAX_LIMIT = 1000;
const MAX_EPOCH_MS = Number.MAX_SAFE_INTEGER;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ItemColumn = 'variant_id' | 'phone_unit_id';
interface ResolvedRef {
  column: ItemColumn;
  id: string;
}

interface HistoryRow {
  id: string;
  created_at: number;
  type: string;
  quantity: number;
  unit_cost: number | null;
  reason: string | null;
  ref_type: string | null;
  ref_id: string | null;
  batch_id: string | null;
  batch_no: string | null;
  expiry_date: string | null;
  created_by: string;
  display_name: string | null;
  invoice_no: string | null;
  customer_name: string | null;
  supplier_name: string | null;
  reference_no: string | null;
  ticket_id: string | null;
  ticket_no: string | null;
  balance_after: number;
}

interface SummaryRow {
  type: string;
  in_range: number | null;
  total: number | null;
}

interface Bounds {
  from: number | null;
  to: number | null;
}

// ---------- input validation ----------

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw invalid(field, `${field} must be a UUID`);
  return v;
}

/** Exactly one of variantId / phoneUnitId, each a UUID. */
export function resolveItemRef(ref: unknown): ResolvedRef {
  if (typeof ref !== 'object' || ref === null) throw invalid('ref', 'ref is required');
  const r = ref as Partial<Record<'variantId' | 'phoneUnitId', unknown>>;
  const hasVariant = r.variantId !== undefined && r.variantId !== null;
  const hasUnit = r.phoneUnitId !== undefined && r.phoneUnitId !== null;
  if (hasVariant === hasUnit)
    throw invalid('ref', 'ref needs exactly one of variantId or phoneUnitId');
  return hasVariant
    ? { column: 'variant_id', id: uuid(r.variantId, 'variantId') }
    : { column: 'phone_unit_id', id: uuid(r.phoneUnitId, 'phoneUnitId') };
}

function bounds(q: ItemHistoryQuery): Bounds {
  const from = q.from === undefined ? null : intIn(q.from, 'from', 0, MAX_EPOCH_MS);
  const to = q.to === undefined ? null : intIn(q.to, 'to', 0, MAX_EPOCH_MS);
  if (from !== null && to !== null && from > to) throw invalid('from', 'from must not be after to');
  return { from, to };
}

/** A non-integer is rejected; an integer outside 1..1000 is clamped. */
function pageLimit(v: unknown): number {
  if (v === undefined) return ITEM_HISTORY_DEFAULT_LIMIT;
  if (typeof v !== 'number' || !Number.isSafeInteger(v))
    throw invalid('limit', 'limit must be an integer');
  return Math.min(Math.max(v, 1), ITEM_HISTORY_MAX_LIMIT);
}

function cursor(v: ItemHistoryQuery['before']): { at: number; id: string } | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') throw invalid('before', 'before must be a cursor');
  return {
    at: intIn(v.at, 'before.at', 0, MAX_EPOCH_MS),
    id: uuid(v.id, 'before.id'),
  };
}

// ---------- SQL ----------

const HISTORY_SQL = (column: ItemColumn): string => `
  SELECT * FROM (
    SELECT sm.id, sm.created_at, sm.type, sm.quantity, sm.unit_cost, sm.reason, sm.ref_type, sm.ref_id,
           sm.batch_id, sb.batch_no, sb.expiry_date,
           sm.created_by, u.display_name,
           s.invoice_no, c.name AS customer_name,
           sp.name AS supplier_name, p.reference_no,
           rp.ticket_id, rt.ticket_no,
           SUM(sm.quantity) OVER (ORDER BY sm.created_at, sm.id) AS balance_after
    FROM stock_movements sm
    LEFT JOIN users u          ON u.id = sm.created_by
    LEFT JOIN stock_batches sb ON sb.id = sm.batch_id
    LEFT JOIN sales s          ON sm.ref_type = 'sale' AND s.id = sm.ref_id
    LEFT JOIN customers c      ON c.id = s.customer_id
    LEFT JOIN purchases p      ON sm.ref_type = 'purchase' AND p.id = sm.ref_id
    LEFT JOIN suppliers sp     ON sp.id = p.supplier_id
    LEFT JOIN repair_parts rp  ON rp.stock_movement_id = sm.id
    LEFT JOIN repair_tickets rt ON rt.id = rp.ticket_id
    WHERE sm.${column} = ?
  )
  WHERE (? IS NULL OR created_at >= ?)
    AND (? IS NULL OR created_at <= ?)
    AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
  ORDER BY created_at DESC, id DESC
  LIMIT ?`;

/** Per movement type: the signed sum inside from/to and the all-time signed sum. */
const SUMMARY_SQL = (column: ItemColumn): string => `
  SELECT type,
         SUM(CASE WHEN (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?)
                  THEN quantity ELSE 0 END) AS in_range,
         SUM(quantity) AS total
  FROM stock_movements WHERE ${column} = ? GROUP BY type`;

// ---------- row mapping ----------

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function kindOf(r: HistoryRow): ItemHistoryKind {
  switch (r.type) {
    case 'sale':
    case 'return':
    case 'purchase':
    case 'transfer':
      return r.type;
    default:
      return r.ticket_id !== null ? 'repair' : 'adjustment';
  }
}

function refOf(r: HistoryRow): ItemHistoryRef {
  if (r.ticket_id !== null && r.ticket_no !== null)
    return { kind: 'repair', ticketId: r.ticket_id, ticketNo: r.ticket_no };
  // A ref whose target row is gone (no FK on ref_id) falls back to a plain adjustment rather than lying.
  if (r.ref_type === 'sale' && r.ref_id !== null && r.invoice_no !== null)
    return {
      kind: r.type === 'return' ? 'return' : 'sale',
      saleId: r.ref_id,
      invoiceNo: r.invoice_no,
      customerName: text(r.customer_name),
    };
  if (r.ref_type === 'purchase' && r.ref_id !== null && r.supplier_name !== null)
    return {
      kind: 'purchase',
      purchaseId: r.ref_id,
      supplierName: r.supplier_name,
      referenceNo: text(r.reference_no),
    };
  if (r.ref_type === 'transfer' && r.ref_id !== null)
    return { kind: 'transfer', transferId: r.ref_id };
  return { kind: 'adjustment' };
}

function toEntry(r: HistoryRow, showCost: boolean): ItemHistoryEntry {
  return {
    id: r.id,
    at: Number(r.created_at),
    kind: kindOf(r),
    quantity: Number(r.quantity),
    balanceAfter: Number(r.balance_after),
    unitCost: !showCost || r.unit_cost === null ? null : (Number(r.unit_cost) as Paisa),
    ref: refOf(r),
    reason: text(r.reason),
    batch:
      r.batch_id !== null && r.expiry_date !== null
        ? { id: r.batch_id, batchNo: text(r.batch_no), expiryDate: r.expiry_date }
        : null,
    by: { id: r.created_by, displayName: r.display_name ?? '' },
  };
}

/**
 * purchased / returned are units that came in, sold is units that went out (all positive); adjusted is the
 * signed net of adjustments (repair parts included); onHand ignores the range. Transfers count in onHand only.
 */
function summarize(rows: SummaryRow[]): ItemHistoryPage['summary'] {
  const inRange = (type: string): number =>
    Number(rows.find((r) => r.type === type)?.in_range ?? 0);
  return {
    purchased: inRange('purchase'),
    sold: Math.abs(inRange('sale')), // sale rows are always negative (CHECK constraint)
    returned: inRange('return'),
    adjusted: inRange('adjustment'),
    onHand: rows.reduce((sum, r) => sum + Number(r.total ?? 0), 0),
  };
}

// ---------- entry point ----------

async function assertItemExists(ctx: Ctx, ref: ResolvedRef): Promise<void> {
  if (ref.column === 'variant_id') await loadVariantRec(ctx.driver, ref.id);
  else await loadPhoneUnitRec(ctx.driver, ref.id);
}

/** Caller has already checked the permission. Throws VALIDATION / NOT_FOUND. */
export async function queryItemHistory(
  ctx: Ctx,
  ref: ItemRef,
  q: ItemHistoryQuery = {},
): Promise<ItemHistoryPage> {
  const item = resolveItemRef(ref);
  const { from, to } = bounds(q);
  const limit = pageLimit(q.limit);
  const before = cursor(q.before);
  await assertItemExists(ctx, item);

  const beforeAt: SqlValue = before === null ? null : before.at;
  const beforeId: SqlValue = before === null ? null : before.id;
  const rows = await ctx.driver.query<HistoryRow>(HISTORY_SQL(item.column), [
    item.id,
    from,
    from,
    to,
    to,
    beforeAt,
    beforeAt,
    beforeAt,
    beforeId,
    limit + 1, // one extra row tells us whether an older page exists
  ]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextBefore =
    rows.length > limit && last !== undefined ? { at: Number(last.created_at), id: last.id } : null;

  const totals = await ctx.driver.query<SummaryRow>(SUMMARY_SQL(item.column), [
    from,
    from,
    to,
    to,
    item.id,
  ]);

  const showCost = canDo(ctx, 'view_cost'); // cashiers see the movements, not what the shop paid
  return {
    entries: page.map((r) => toEntry(r, showCost)),
    nextBefore,
    summary: summarize(totals),
  };
}
