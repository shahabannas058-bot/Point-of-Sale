import { negPaisa, paisa } from '@pos/core';
import {
  PaymentMethodSchema,
  ServiceError,
  type Customer,
  type KhataApi,
  type LedgerEntry,
  type LedgerLine,
  type PartyBalance,
} from '@pos/shared';
import { WriteBatch } from './batch';
import { canDo, requirePermission, requireSession, type Ctx } from './deps';
import { guardApi, intIn, invalid, money, optCnic, optPhone, optText, reqText } from './errors';
import { customerStatement, pendingUdhaar } from './khata-statement';
import { mapRow, type Raw } from './mappers';
import {
  customerBalance,
  insertCustomer,
  insertLedger,
  loadCustomerRec,
  updateCustomer,
  type CustomerRec,
} from './queries';
import type { SqlValue } from '../types';

const NON_KHATA = PaymentMethodSchema.exclude(['khata']);

export function createKhataApi(ctx: Ctx): KhataApi {
  return guardApi<KhataApi>({
    async listCustomers(o = {}) {
      requireSession(ctx);
      const conds = ['c.is_active = 1'];
      const params: SqlValue[] = [];
      if (o.q !== undefined && o.q.trim() !== '') {
        conds.push("(c.name LIKE ? ESCAPE '\\' OR COALESCE(c.phone, '') LIKE ? ESCAPE '\\')");
        const like = `%${o.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        params.push(like, like);
      }
      const rows = await ctx.driver.query<Raw>(
        `SELECT * FROM (
           SELECT c.*,
             COALESCE((SELECT SUM(amount) FROM ledger_entries WHERE customer_id = c.id), 0) AS balance,
             (SELECT MAX(created_at) FROM ledger_entries WHERE customer_id = c.id) AS last_activity_at
           FROM customers c WHERE ${conds.join(' AND ')}
         ) ${o.withBalanceOnly === true ? 'WHERE balance <> 0' : ''} ORDER BY name`,
        params,
      );
      return rows.map((r): PartyBalance<Customer> => {
        const { balance, last_activity_at: last, ...customer } = r;
        return {
          party: mapRow<Customer>(customer),
          balance: paisa(Number(balance)),
          lastActivityAt: last === null || last === undefined ? null : Number(last),
        };
      });
    },

    async createCustomer(i) {
      const session = requirePermission(ctx, 'sell');
      const name = reqText(i.name, 'name', 1, 100);
      const phone = optPhone(i.phone, 'phone');
      const cnic = optCnic(i.cnic, 'cnic');
      const address = optText(i.address, 'address', 300);
      const creditLimit =
        i.creditLimit === undefined || i.creditLimit === null
          ? null
          : money(i.creditLimit, 'creditLimit');
      const opening =
        i.openingBalance === undefined ? 0 : money(i.openingBalance, 'openingBalance');
      return ctx.lock(async () => {
        const at = ctx.clock();
        const rec: CustomerRec = {
          id: ctx.newId(),
          name,
          phone,
          cnic,
          address,
          creditLimit,
          notes: null,
          isActive: true,
          createdAt: at,
          updatedAt: at,
        };
        const b = new WriteBatch(ctx.newId, at);
        insertCustomer(b, rec);
        if (opening > 0)
          insertLedger(b, {
            id: ctx.newId(),
            customerId: rec.id,
            supplierId: null,
            type: 'opening_balance',
            amount: opening,
            method: null,
            saleId: null,
            purchaseId: null,
            note: 'Opening balance',
            createdBy: session.user.id,
            createdAt: at,
          });
        await b.commit(ctx.driver);
        return rec as unknown as Customer;
      });
    },

    async updateCustomer(id, p) {
      // Changing the credit limit is a manager decision; everything else the till operator may fix.
      requirePermission(ctx, p.creditLimit !== undefined ? 'edit_catalog' : 'sell');
      return ctx.lock(async () => {
        const cur = await loadCustomerRec(ctx.driver, id);
        const at = ctx.clock();
        const next: CustomerRec = { ...cur, updatedAt: at };
        if (p.name !== undefined) next.name = reqText(p.name, 'name', 1, 100);
        if (p.phone !== undefined) next.phone = optPhone(p.phone, 'phone');
        if (p.address !== undefined) next.address = optText(p.address, 'address', 300);
        if (p.notes !== undefined) next.notes = optText(p.notes, 'notes', 500);
        if (p.creditLimit !== undefined)
          next.creditLimit = p.creditLimit === null ? null : money(p.creditLimit, 'creditLimit');
        const b = new WriteBatch(ctx.newId, at);
        updateCustomer(b, next);
        await b.commit(ctx.driver);
        return next as unknown as Customer;
      });
    },

    async getLedger(customerId, o = {}) {
      requireSession(ctx);
      const customerRow = (
        await ctx.driver.query<Raw>('SELECT * FROM customers WHERE id = ?', [customerId])
      )[0];
      if (customerRow === undefined)
        throw new ServiceError('NOT_FOUND', 'Customer not found', { id: customerId });
      const customer = mapRow<Customer>(customerRow);
      const limit = o.limit === undefined ? 100 : intIn(o.limit, 'limit', 1, 1000);
      const before = o.beforeCreatedAt ?? null;
      const rows = await ctx.driver.query<Raw>(
        `SELECT * FROM (
           SELECT le.*, s.invoice_no AS invoice_no,
             SUM(le.amount) OVER (ORDER BY le.created_at, le.id) AS running_balance
           FROM ledger_entries le LEFT JOIN sales s ON s.id = le.sale_id
           WHERE le.customer_id = ?
         ) WHERE (? IS NULL OR created_at < ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
        [customerId, before, before, limit],
      );
      const lines = rows.map((r): LedgerLine => {
        const { running_balance: running, invoice_no: invoiceNo, ...entry } = r;
        return {
          entry: mapRow<LedgerEntry>(entry),
          runningBalance: paisa(Number(running)),
          invoiceNo: typeof invoiceNo === 'string' ? invoiceNo : null,
        };
      });
      return { customer, balance: paisa(await customerBalance(ctx.driver, customerId)), lines };
    },

    async receivePayment(i) {
      const session = requirePermission(ctx, 'receive_khata');
      const amount = money(i.amount, 'amount', { allowZero: false });
      const method = NON_KHATA.safeParse(i.method);
      if (!method.success) throw invalid('method', 'Payment method cannot be khata');
      const note = optText(i.note, 'note', 500);
      await ctx.lock(async () => {
        await loadCustomerRec(ctx.driver, i.customerId); // NOT_FOUND
        const balance = await customerBalance(ctx.driver, i.customerId);
        if (amount > balance)
          throw new ServiceError('VALIDATION', 'Payment is more than the customer owes', {
            field: 'amount',
            balance,
          });
        const at = ctx.clock();
        const b = new WriteBatch(ctx.newId, at);
        insertLedger(b, {
          id: ctx.newId(),
          customerId: i.customerId,
          supplierId: null,
          type: 'payment_received',
          amount: negPaisa(amount),
          method: method.data,
          saleId: null,
          purchaseId: null,
          note,
          createdBy: session.user.id,
          createdAt: at,
        });
        await b.commit(ctx.driver);
      });
      return paisa(await customerBalance(ctx.driver, i.customerId));
    },

    async totals() {
      requireSession(ctx);
      if (!canDo(ctx, 'receive_khata') && !canDo(ctx, 'view_reports'))
        throw new ServiceError('FORBIDDEN', 'Permission required: receive_khata', {
          permission: 'receive_khata',
        });
      const rows = await ctx.driver.query<{ receivable: number; owing: number }>(
        `SELECT COALESCE(SUM(balance), 0) AS receivable, COUNT(*) AS owing FROM (
           SELECT customer_id, SUM(amount) AS balance FROM ledger_entries
           WHERE customer_id IS NOT NULL GROUP BY customer_id HAVING SUM(amount) > 0)`,
      );
      return {
        receivable: paisa(rows[0]?.receivable ?? 0),
        customersOwing: rows[0]?.owing ?? 0,
      };
    },

    statement: (customerId, range) => customerStatement(ctx, customerId, range),
    pendingUdhaar: () => pendingUdhaar(ctx),
  });
}
