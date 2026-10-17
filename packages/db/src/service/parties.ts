import { paisa } from '@pos/core';
import {
  PAYMENT_METHODS,
  type Customer,
  type Id,
  type LedgerEntry,
  type LedgerEntryType,
  type LedgerLine,
  type PartyBalance,
  type PaymentMethod,
  type PosService,
  type Supplier,
} from '@pos/shared';
import type { SqlValue, Statement } from '../driver';
import {
  emit,
  insert,
  loadMeta,
  one,
  q,
  requirePerm,
  scalar,
  toCustomer,
  toSupplier,
  variantView,
  write,
  type Ctx,
} from './context';
import { movement, phoneUnitStatements } from './catalog';
import { fail, intIn, invalid, money, optMoney, optText, text } from './errors';

type CashMethod = Exclude<PaymentMethod, 'khata'>;

const checkMethod = (m: unknown, field = 'method'): CashMethod => {
  if (typeof m !== 'string' || m === 'khata' || !(PAYMENT_METHODS as readonly string[]).includes(m))
    return invalid(field, 'Unknown payment method');
  return m as CashMethod;
};

const CNIC = /^\d{13}$/;

export function ledgerStatement(
  ctx: Ctx,
  e: {
    customerId?: Id | null;
    supplierId?: Id | null;
    type: LedgerEntryType;
    amount: number;
    method?: CashMethod | null;
    saleId?: Id | null;
    purchaseId?: Id | null;
    note?: string | null;
    userId: Id;
    t: number;
  },
): Statement[] {
  const id = ctx.newId();
  const row = {
    id,
    customer_id: e.customerId ?? null,
    supplier_id: e.supplierId ?? null,
    type: e.type,
    amount: e.amount,
    method: e.method ?? null,
    sale_id: e.saleId ?? null,
    purchase_id: e.purchaseId ?? null,
    note: e.note ?? null,
    created_by: e.userId,
    created_at: e.t,
  };
  return [insert('ledger_entries', row), emit(ctx, 'ledger_entry', id, row, e.t)];
}

const toEntry = (r: Record<string, SqlValue>): LedgerEntry => ({
  id: String(r.id),
  customerId: r.customer_id === null ? null : String(r.customer_id),
  supplierId: r.supplier_id === null ? null : String(r.supplier_id),
  type: String(r.type) as LedgerEntryType,
  amount: paisa(Number(r.amount)),
  method: r.method === null ? null : (String(r.method) as CashMethod),
  saleId: r.sale_id === null ? null : String(r.sale_id),
  purchaseId: r.purchase_id === null ? null : String(r.purchase_id),
  note: r.note === null ? null : String(r.note),
  createdBy: String(r.created_by),
  createdAt: Number(r.created_at),
});

export const customerBalance = (ctx: Ctx, id: Id): Promise<number> =>
  scalar(ctx, 'SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE customer_id = ?', [
    id,
  ]);

const supplierBalance = (ctx: Ctx, id: Id): Promise<number> =>
  scalar(ctx, 'SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE supplier_id = ?', [
    id,
  ]);

// ---------------- khata (customers) ----------------

export function khataApi(ctx: Ctx): PosService['khata'] {
  return {
    async listCustomers(o = {}) {
      requirePerm(ctx, 'receive_khata');
      const qy = o.q?.trim().toLowerCase();
      const rows = await q(
        ctx,
        `SELECT c.*,
                COALESCE((SELECT SUM(amount) FROM ledger_entries le WHERE le.customer_id = c.id), 0) AS balance,
                (SELECT MAX(created_at) FROM ledger_entries le WHERE le.customer_id = c.id) AS last_at
         FROM customers c
         WHERE c.is_active = 1 ${qy ? "AND lower(c.name || ' ' || COALESCE(c.phone,'') || ' ' || COALESCE(c.cnic,'')) LIKE ?" : ''}
         ORDER BY balance DESC, c.name`,
        qy ? [`%${qy}%`] : [],
      );
      return rows
        .map((r): PartyBalance<Customer> => ({
          party: toCustomer(r),
          balance: paisa(Number(r.balance)),
          lastActivityAt: r.last_at === null ? null : Number(r.last_at),
        }))
        .filter((r) => (o.withBalanceOnly ? r.balance !== 0 : true));
    },

    createCustomer: (i) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'receive_khata');
        const cnic = optText(i.cnic, 'cnic', 13);
        if (cnic !== null && !CNIC.test(cnic)) invalid('cnic', 'CNIC must be 13 digits');
        const opening = optMoney(i.openingBalance, 'openingBalance') ?? 0;
        const t = ctx.now();
        const id = ctx.newId();
        const row = {
          id,
          name: text(i.name, 'name', 80),
          phone: optText(i.phone, 'phone', 20),
          cnic,
          address: optText(i.address, 'address', 200),
          credit_limit: optMoney(i.creditLimit, 'creditLimit'),
          notes: null,
          is_active: 1,
          created_at: t,
          updated_at: t,
        };
        const stmts = [insert('customers', row), emit(ctx, 'customer', id, row, t)];
        if (opening > 0)
          stmts.push(
            ...ledgerStatement(ctx, {
              customerId: id,
              type: 'opening_balance',
              amount: opening,
              userId: s.user.id,
              t,
            }),
          );
        await write(ctx, stmts);
        return toCustomer(row);
      }),

    updateCustomer: (id, p) =>
      ctx.lock(async () => {
        requirePerm(ctx, 'receive_khata');
        const cur = await one(ctx, 'SELECT * FROM customers WHERE id = ?', [id]);
        if (!cur) return fail('NOT_FOUND', 'Customer not found');
        const cols: Record<string, SqlValue> = {};
        if (p.name !== undefined) cols.name = text(p.name, 'name', 80);
        if (p.phone !== undefined) cols.phone = optText(p.phone, 'phone', 20);
        if (p.cnic !== undefined) {
          const c = optText(p.cnic, 'cnic', 13);
          if (c !== null && !CNIC.test(c)) invalid('cnic', 'CNIC must be 13 digits');
          cols.cnic = c;
        }
        if (p.address !== undefined) cols.address = optText(p.address, 'address', 200);
        if (p.notes !== undefined) cols.notes = optText(p.notes, 'notes', 400);
        if (p.creditLimit !== undefined) cols.credit_limit = optMoney(p.creditLimit, 'creditLimit');
        if (p.isActive !== undefined) cols.is_active = p.isActive ? 1 : 0;
        const keys = Object.keys(cols);
        if (keys.length > 0) {
          const t = ctx.now();
          await write(ctx, [
            {
              sql: `UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
              params: [...keys.map((k) => cols[k] ?? null), t, id],
            },
            emit(ctx, 'customer', id, { id, ...cols, updated_at: t }, t, 'update'),
          ]);
        }
        const row = await one(ctx, 'SELECT * FROM customers WHERE id = ?', [id]);
        return row ? toCustomer(row) : fail('NOT_FOUND', 'Customer not found');
      }),

    async getLedger(customerId, o = {}) {
      requirePerm(ctx, 'receive_khata');
      const row = await one(ctx, 'SELECT * FROM customers WHERE id = ?', [customerId]);
      if (!row) return fail('NOT_FOUND', 'Customer not found');
      const rows = await q(
        ctx,
        `SELECT le.*, s.invoice_no FROM ledger_entries le LEFT JOIN sales s ON s.id = le.sale_id
         WHERE le.customer_id = ? ORDER BY le.created_at, le.id`,
        [customerId],
      );
      let running = 0;
      const all: LedgerLine[] = rows.map((r) => {
        running += Number(r.amount);
        return {
          entry: toEntry(r),
          runningBalance: paisa(running),
          invoiceNo:
            r.invoice_no === null || r.invoice_no === undefined ? null : String(r.invoice_no),
        };
      });
      const before = o.beforeCreatedAt;
      const lines = all
        .filter((l) => (before ? l.entry.createdAt < before : true))
        .slice(-(o.limit ?? 500))
        .reverse();
      return { customer: toCustomer(row), balance: paisa(running), lines };
    },

    receivePayment: ({ customerId, amount, method, note }) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'receive_khata');
        const amt = money(amount, 'amount', { allowZero: false });
        const m = checkMethod(method);
        if (!(await one(ctx, 'SELECT 1 AS x FROM customers WHERE id = ?', [customerId])))
          fail('NOT_FOUND', 'Customer not found');
        const bal = await customerBalance(ctx, customerId);
        if (amt > bal) invalid('amount', 'Amount must be between 1 paisa and the balance');
        await write(
          ctx,
          ledgerStatement(ctx, {
            customerId,
            type: 'payment_received',
            amount: -amt,
            method: m,
            note: optText(note, 'note', 200),
            userId: s.user.id,
            t: ctx.now(),
          }),
        );
        return paisa(await customerBalance(ctx, customerId));
      }),

    async totals() {
      requirePerm(ctx, 'receive_khata');
      const r = await one<{ receivable: number | null; owing: number }>(
        ctx,
        `SELECT SUM(b) AS receivable, COUNT(*) AS owing FROM (
           SELECT SUM(amount) AS b FROM ledger_entries WHERE customer_id IS NOT NULL GROUP BY customer_id
         ) WHERE b > 0`,
      );
      return {
        receivable: paisa(Number(r?.receivable ?? 0)),
        customersOwing: Number(r?.owing ?? 0),
      };
    },
  };
}

// ---------------- purchasing (suppliers) ----------------

export function purchasingApi(ctx: Ctx): PosService['purchasing'] {
  return {
    async listSuppliers() {
      requirePerm(ctx, 'receive_stock');
      const rows = await q(
        ctx,
        `SELECT s.*,
                COALESCE((SELECT SUM(amount) FROM ledger_entries le WHERE le.supplier_id = s.id), 0) AS balance,
                (SELECT MAX(created_at) FROM ledger_entries le WHERE le.supplier_id = s.id) AS last_at
         FROM suppliers s WHERE s.is_active = 1 ORDER BY s.name`,
      );
      return rows.map((r): PartyBalance<Supplier> => ({
        party: toSupplier(r),
        balance: paisa(Number(r.balance)),
        lastActivityAt: r.last_at === null ? null : Number(r.last_at),
      }));
    },

    createSupplier: (i) =>
      ctx.lock(async () => {
        requirePerm(ctx, 'receive_stock');
        const t = ctx.now();
        const id = ctx.newId();
        const row = {
          id,
          name: text(i.name, 'name', 80),
          phone: optText(i.phone, 'phone', 20),
          address: optText(i.address, 'address', 200),
          notes: null,
          is_active: 1,
          created_at: t,
          updated_at: t,
        };
        await write(ctx, [insert('suppliers', row), emit(ctx, 'supplier', id, row, t)]);
        return toSupplier(row);
      }),

    receive: (i) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'receive_stock');
        const meta = await loadMeta(ctx);
        if (!(await one(ctx, 'SELECT 1 AS x FROM suppliers WHERE id = ?', [i.supplierId])))
          fail('NOT_FOUND', 'Supplier not found');
        if (i.phones.length === 0 && i.accessories.length === 0)
          invalid('phones', 'Nothing to receive');
        const t = ctx.now();
        const purchaseId = ctx.newId();
        const stmts: Statement[] = [];
        const phoneUnitIds: Id[] = [];
        let total = 0;

        const seenImeis = new Set<string>();
        for (const p of i.phones) {
          for (const v of [p.imei1, p.imei2, p.serial])
            if (v) {
              if (seenImeis.has(v))
                fail('DUPLICATE', 'The same IMEI / serial is entered twice', { field: 'imei1' });
              seenImeis.add(v);
            }
          const r = await phoneUnitStatements(
            ctx,
            { ...p, supplierId: i.supplierId },
            {
              branchId: meta.branchId,
              userId: s.user.id,
              t,
              movement: 'purchase',
              refId: purchaseId,
            },
          );
          phoneUnitIds.push(r.id);
          stmts.push(...r.statements);
          total += money(p.costPrice, 'costPrice');
        }
        for (const [idx, a] of i.accessories.entries()) {
          const v = await variantView(ctx, meta.branchId, a.variantId);
          const qty = intIn(a.quantity, `accessories.${String(idx)}.quantity`, 1, 1_000_000);
          const cost = money(a.unitCost, `accessories.${String(idx)}.unitCost`);
          stmts.push(
            ...movement(ctx, {
              branchId: meta.branchId,
              type: 'purchase',
              phoneUnitId: null,
              variantId: v.variant.id,
              quantity: qty,
              unitCost: cost,
              refType: 'purchase',
              refId: purchaseId,
              reason: null,
              userId: s.user.id,
              t,
            }),
          );
          if (cost !== v.variant.costPrice)
            stmts.push({
              sql: 'UPDATE accessory_variants SET cost_price = ?, updated_at = ? WHERE id = ?',
              params: [cost, t, v.variant.id],
            });
          total += qty * cost;
        }

        const paid = i.paidNow ? money(i.paidNow.amount, 'paidNow.amount') : 0;
        if (paid > total)
          invalid('paidNow.amount', 'Paid now cannot be more than the purchase total');
        const purchaseRow = {
          id: purchaseId,
          supplier_id: i.supplierId,
          branch_id: meta.branchId,
          kind: 'purchase',
          reference_no: optText(i.referenceNo, 'referenceNo', 60),
          total,
          note: optText(i.note, 'note', 400),
          created_by: s.user.id,
          created_at: t,
        };
        // the purchase row must exist before movements that reference it
        stmts.unshift(
          insert('purchases', purchaseRow),
          emit(ctx, 'purchase', purchaseId, purchaseRow, t),
        );
        if (total > 0)
          stmts.push(
            ...ledgerStatement(ctx, {
              supplierId: i.supplierId,
              type: 'purchase_credit',
              amount: total,
              purchaseId,
              userId: s.user.id,
              t,
            }),
          );
        if (paid > 0 && i.paidNow)
          stmts.push(
            ...ledgerStatement(ctx, {
              supplierId: i.supplierId,
              type: 'payment_made',
              amount: -paid,
              method: checkMethod(i.paidNow.method, 'paidNow.method'),
              purchaseId,
              userId: s.user.id,
              t,
            }),
          );
        await write(ctx, stmts);
        return {
          purchase: {
            id: purchaseId,
            supplierId: i.supplierId,
            branchId: meta.branchId,
            kind: 'purchase' as const,
            referenceNo: purchaseRow.reference_no,
            total: paisa(total),
            note: purchaseRow.note,
            createdBy: s.user.id,
            createdAt: t,
          },
          phoneUnitIds,
          supplierBalance: paisa(await supplierBalance(ctx, i.supplierId)),
        };
      }),

    paySupplier: ({ supplierId, amount, method, note }) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'receive_stock');
        const amt = money(amount, 'amount', { allowZero: false });
        if (!(await one(ctx, 'SELECT 1 AS x FROM suppliers WHERE id = ?', [supplierId])))
          fail('NOT_FOUND', 'Supplier not found');
        await write(
          ctx,
          ledgerStatement(ctx, {
            supplierId,
            type: 'payment_made',
            amount: -amt,
            method: checkMethod(method ?? 'cash'),
            note: optText(note, 'note', 200),
            userId: s.user.id,
            t: ctx.now(),
          }),
        );
        return paisa(await supplierBalance(ctx, supplierId));
      }),
  };
}
