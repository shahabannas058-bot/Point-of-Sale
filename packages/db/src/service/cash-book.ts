import { negPaisa, paisa } from '@pos/core';
import {
  CashEntryTypeSchema,
  ExpenseCategorySchema,
  ServiceError,
  type CashApi,
  type CashEntry,
  type CashEntryView,
  type DayClose,
  type DrawerBreakdown,
} from '@pos/shared';
import type { SqlDriver } from '../types';
import { WriteBatch } from './batch';
import { requirePermission, type Ctx } from './deps';
import { guardApi, intIn, invalid, money, optText } from './errors';
import { mapRow, type Raw } from './mappers';
import { loadShop } from './meta';

const DEFAULT_CLOSES = 30;
const MAX_CLOSES = 500;
const NOTE_MAX = 500;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Cash totals of one branch over [from, to). Sales and repairs carry their own payment rows; udhaar and supplier
 * payments are ledger entries; everything else is in cash_entries. Only method = 'cash' moves the drawer.
 */
async function breakdown(
  driver: SqlDriver,
  branchId: string,
  opening: number,
  from: number,
  to: number,
): Promise<DrawerBreakdown> {
  const ft = [from, to];
  const bft = [branchId, from, to];
  const r =
    (
      await driver.query<Raw>(
        `SELECT
           (SELECT COALESCE(SUM(p.amount), 0) FROM payments p JOIN sales s ON s.id = p.sale_id
             WHERE p.method = 'cash' AND s.kind = 'sale' AND s.branch_id = ?
               AND p.created_at >= ? AND p.created_at < ?) AS cash_sales,
           (SELECT COALESCE(-SUM(p.amount), 0) FROM payments p JOIN sales s ON s.id = p.sale_id
             WHERE p.method = 'cash' AND s.kind IN ('return', 'void') AND s.branch_id = ?
               AND p.created_at >= ? AND p.created_at < ?) AS cash_refunds,
           (SELECT COALESCE(-SUM(amount), 0) FROM ledger_entries
             WHERE customer_id IS NOT NULL AND type = 'payment_received' AND method = 'cash'
               AND created_at >= ? AND created_at < ?) AS udhaar_collected,
           (SELECT COALESCE(-SUM(amount), 0) FROM ledger_entries
             WHERE supplier_id IS NOT NULL AND type = 'payment_made' AND method = 'cash'
               AND created_at >= ? AND created_at < ?) AS supplier_paid,
           (SELECT COALESCE(SUM(amount), 0) FROM repair_payments
             WHERE method = 'cash' AND created_at >= ? AND created_at < ?) AS repair_cash,
           (SELECT COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) FROM cash_entries
             WHERE branch_id = ? AND created_at >= ? AND created_at < ?) AS expenses,
           (SELECT COALESCE(SUM(CASE WHEN type = 'cash_in' THEN amount END), 0) FROM cash_entries
             WHERE branch_id = ? AND created_at >= ? AND created_at < ?) AS cash_in,
           (SELECT COALESCE(SUM(CASE WHEN type = 'cash_out' THEN amount END), 0) FROM cash_entries
             WHERE branch_id = ? AND created_at >= ? AND created_at < ?) AS cash_out`,
        [...bft, ...bft, ...ft, ...ft, ...ft, ...bft, ...bft, ...bft],
      )
    )[0] ?? {};
  const b = {
    cashSales: num(r.cash_sales),
    cashRefunds: num(r.cash_refunds),
    udhaarCollected: num(r.udhaar_collected),
    supplierPaid: num(r.supplier_paid),
    repairCash: num(r.repair_cash),
    expenses: num(r.expenses),
    cashIn: num(r.cash_in),
    cashOut: num(r.cash_out),
  };
  const expected =
    opening +
    b.cashSales -
    b.cashRefunds +
    b.udhaarCollected -
    b.supplierPaid +
    b.repairCash -
    b.expenses +
    b.cashIn -
    b.cashOut;
  return {
    opening: paisa(opening),
    cashSales: paisa(b.cashSales),
    cashRefunds: paisa(b.cashRefunds),
    udhaarCollected: paisa(b.udhaarCollected),
    supplierPaid: paisa(b.supplierPaid),
    repairCash: paisa(b.repairCash),
    expenses: paisa(b.expenses),
    cashIn: paisa(b.cashIn),
    cashOut: paisa(b.cashOut),
    expected: paisa(expected),
  };
}

const CLOSE_SQL = `SELECT dc.*, u.display_name AS closed_by_name
  FROM day_closes dc JOIN users u ON u.id = dc.closed_by`;

function toDayClose(row: Raw): DayClose {
  const c = mapRow<Omit<DayClose, 'difference'>>(row);
  return { ...c, difference: paisa(c.counted - c.expected) };
}

async function lastClose(driver: SqlDriver, branchId: string): Promise<DayClose | null> {
  const row = (
    await driver.query<Raw>(
      `${CLOSE_SQL} WHERE dc.branch_id = ? ORDER BY dc.closed_at DESC LIMIT 1`,
      [branchId],
    )
  )[0];
  return row === undefined ? null : toDayClose(row);
}

async function periodEntries(
  driver: SqlDriver,
  branchId: string,
  from: number,
  to: number,
): Promise<CashEntryView[]> {
  const rows = await driver.query<Raw>(
    `SELECT ce.*, u.display_name AS created_by_name,
       EXISTS (SELECT 1 FROM cash_entries r WHERE r.reverses_id = ce.id) AS reversed
     FROM cash_entries ce JOIN users u ON u.id = ce.created_by
     WHERE ce.branch_id = ? AND ce.created_at >= ? AND ce.created_at < ?
     ORDER BY ce.created_at, ce.id`,
    [branchId, from, to],
  );
  return rows.map((r) => {
    const v = mapRow<Omit<CashEntryView, 'reversed'> & { reversed: unknown }>(r);
    return { ...v, reversed: num(v.reversed) === 1 };
  });
}

const clockBehind = (): ServiceError =>
  invalid('clock', 'The PC clock is behind the last day close; fix the date and time');

/** An entry stamped before the last close would fall into a closed period and never be counted. */
async function assertClockAfterLastClose(
  driver: SqlDriver,
  branchId: string,
  at: number,
): Promise<void> {
  const last = await lastClose(driver, branchId);
  if (last !== null && at < last.closedAt) throw clockBehind();
}

function insertEntry(b: WriteBatch, e: CashEntry): void {
  b.add(
    `INSERT INTO cash_entries (id, branch_id, type, category, amount, note, reverses_id, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      e.id,
      e.branchId,
      e.type,
      e.category,
      e.amount,
      e.note,
      e.reversesId,
      e.createdBy,
      e.createdAt,
    ],
  ).emit('cash_entry', e.id, 'insert', e);
}

export function createCashApi(ctx: Ctx): CashApi {
  return guardApi<CashApi>({
    async drawer() {
      requirePermission(ctx, 'sell');
      const shop = await loadShop(ctx.driver);
      const last = await lastClose(ctx.driver, shop.branchId);
      const from = last?.closedAt ?? 0;
      const asOf = ctx.clock();
      const totals = await breakdown(
        ctx.driver,
        shop.branchId,
        last?.carriedForward ?? 0,
        from,
        asOf,
      );
      return {
        ...totals,
        periodStart: from,
        asOf,
        entries: await periodEntries(ctx.driver, shop.branchId, from, asOf),
        lastClose: last,
      };
    },

    async addEntry(i) {
      const session = requirePermission(ctx, 'sell');
      const type = CashEntryTypeSchema.safeParse(i.type);
      if (!type.success) throw invalid('type', 'Unknown cash entry type');
      let category: CashEntry['category'] = null;
      if (type.data === 'expense') {
        const c = ExpenseCategorySchema.safeParse(i.category);
        if (!c.success) throw invalid('category', 'An expense needs a category');
        category = c.data;
      } else if (i.category !== undefined && i.category !== null) {
        throw invalid('category', 'Only an expense has a category');
      }
      const amount = money(i.amount, 'amount', { allowZero: false });
      const note = optText(i.note, 'note', NOTE_MAX);
      return ctx.lock(async () => {
        const shop = await loadShop(ctx.driver);
        const at = ctx.clock();
        await assertClockAfterLastClose(ctx.driver, shop.branchId, at);
        const entry: CashEntry = {
          id: ctx.newId(),
          branchId: shop.branchId,
          type: type.data,
          category,
          amount,
          note,
          reversesId: null,
          createdBy: session.user.id,
          createdAt: at,
        };
        const b = new WriteBatch(ctx.newId, at);
        insertEntry(b, entry);
        await ctx.assertCanSell({ action: 'cash', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
        return entry;
      });
    },

    async reverseEntry(i) {
      const session = requirePermission(ctx, 'return_void');
      const reason = optText(i.reason, 'reason', NOTE_MAX);
      return ctx.lock(async () => {
        const row = (
          await ctx.driver.query<Raw>(
            `SELECT ce.*, EXISTS (SELECT 1 FROM cash_entries r WHERE r.reverses_id = ce.id) AS reversed
             FROM cash_entries ce WHERE ce.id = ?`,
            [i.entryId],
          )
        )[0];
        if (row === undefined)
          throw new ServiceError('NOT_FOUND', 'Cash entry not found', { id: i.entryId });
        const { reversed, ...raw } = row;
        const original = mapRow<CashEntry>(raw);
        if (original.reversesId !== null) throw invalid('entryId', 'A reversal cannot be reversed');
        if (num(reversed) === 1) throw invalid('entryId', 'This entry is already reversed');
        const last = await lastClose(ctx.driver, original.branchId);
        if (last !== null && original.createdAt < last.closedAt)
          throw invalid('entryId', 'The day of this entry is already closed');
        const at = ctx.clock();
        const entry: CashEntry = {
          ...original,
          id: ctx.newId(),
          amount: negPaisa(original.amount),
          note: reason,
          reversesId: original.id,
          createdBy: session.user.id,
          createdAt: at,
        };
        const b = new WriteBatch(ctx.newId, at);
        insertEntry(b, entry);
        await ctx.assertCanSell({ action: 'cash', branchId: original.branchId, now: at });
        await b.commit(ctx.driver);
        return entry;
      });
    },

    async closeDay(i) {
      const session = requirePermission(ctx, 'sell');
      const counted = money(i.counted, 'counted');
      const carriedForward = money(i.carriedForward, 'carriedForward');
      if (carriedForward > counted)
        throw invalid('carriedForward', 'Cannot leave more in the drawer than was counted');
      const note = optText(i.note, 'note', NOTE_MAX);
      return ctx.lock(async () => {
        const shop = await loadShop(ctx.driver);
        const last = await lastClose(ctx.driver, shop.branchId);
        const from = last?.closedAt ?? 0;
        const at = ctx.clock();
        if (at < from) throw clockBehind();
        const totals = await breakdown(
          ctx.driver,
          shop.branchId,
          last?.carriedForward ?? 0,
          from,
          at,
        );
        const close: DayClose = {
          ...totals,
          id: ctx.newId(),
          branchId: shop.branchId,
          periodStart: from,
          closedAt: at,
          counted,
          carriedForward,
          difference: paisa(counted - totals.expected),
          note,
          closedBy: session.user.id,
          closedByName: session.user.displayName,
        };
        const { difference: _d, closedByName: _n, ...rec } = close;
        const b = new WriteBatch(ctx.newId, at);
        b.add(
          `INSERT INTO day_closes (id, branch_id, period_start, closed_at, opening, cash_sales, cash_refunds,
             udhaar_collected, supplier_paid, repair_cash, expenses, cash_in, cash_out, expected, counted,
             carried_forward, note, closed_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            rec.id,
            rec.branchId,
            rec.periodStart,
            rec.closedAt,
            rec.opening,
            rec.cashSales,
            rec.cashRefunds,
            rec.udhaarCollected,
            rec.supplierPaid,
            rec.repairCash,
            rec.expenses,
            rec.cashIn,
            rec.cashOut,
            rec.expected,
            rec.counted,
            rec.carriedForward,
            rec.note,
            rec.closedBy,
          ],
        ).emit('day_close', rec.id, 'insert', rec);
        await ctx.assertCanSell({ action: 'cash', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
        return close;
      });
    },

    async listCloses(o) {
      requirePermission(ctx, 'view_reports');
      const limit =
        o?.limit === undefined ? DEFAULT_CLOSES : intIn(o.limit, 'limit', 1, MAX_CLOSES);
      const shop = await loadShop(ctx.driver);
      const rows = await ctx.driver.query<Raw>(
        `${CLOSE_SQL} WHERE dc.branch_id = ? ORDER BY dc.closed_at DESC LIMIT ?`,
        [shop.branchId, limit],
      );
      return rows.map(toDayClose);
    },
  });
}
