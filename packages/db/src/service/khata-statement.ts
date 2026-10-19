import { paisa } from '@pos/core';
import {
  ServiceError,
  type Customer,
  type CustomerStatement,
  type LedgerEntry,
  type LedgerLine,
  type PendingUdhaar,
  type SummaryRange,
} from '@pos/shared';
import { requireSession, type Ctx } from './deps';
import { mapRow, type Raw } from './mappers';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const epochOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

function assertRange(range: SummaryRange): void {
  if (
    !Number.isSafeInteger(range.fromMs) ||
    !Number.isSafeInteger(range.toMs) ||
    range.toMs < range.fromMs
  )
    throw new ServiceError('VALIDATION', 'Invalid statement range', { field: 'range' });
}

async function loadCustomer(ctx: Ctx, customerId: string): Promise<Customer> {
  const row = (
    await ctx.driver.query<Raw>('SELECT * FROM customers WHERE id = ?', [customerId])
  )[0];
  if (row === undefined)
    throw new ServiceError('NOT_FOUND', 'Customer not found', { id: customerId });
  return mapRow<Customer>(row);
}

/** Opening balance, every ledger entry inside [from, to) with a running balance, and the period totals. */
export async function customerStatement(
  ctx: Ctx,
  customerId: string,
  range: SummaryRange,
): Promise<CustomerStatement> {
  requireSession(ctx);
  assertRange(range);
  const customer = await loadCustomer(ctx, customerId);
  const openingRow = (
    await ctx.driver.query<{ opening: number }>(
      'SELECT COALESCE(SUM(amount), 0) AS opening FROM ledger_entries WHERE customer_id = ? AND created_at < ?',
      [customerId, range.fromMs],
    )
  )[0];
  const opening = num(openingRow?.opening);
  const rows = await ctx.driver.query<Raw>(
    `SELECT le.*, s.invoice_no AS invoice_no
     FROM ledger_entries le LEFT JOIN sales s ON s.id = le.sale_id
     WHERE le.customer_id = ? AND le.created_at >= ? AND le.created_at < ?
     ORDER BY le.created_at, le.id`,
    [customerId, range.fromMs, range.toMs],
  );
  let running = opening;
  let udhaarGiven = 0;
  let paid = 0;
  const lines = rows.map((r): LedgerLine => {
    const { invoice_no: invoiceNo, ...raw } = r;
    const entry = mapRow<LedgerEntry>(raw);
    running += entry.amount;
    if (entry.amount > 0) udhaarGiven += entry.amount;
    else paid -= entry.amount;
    return {
      entry,
      runningBalance: paisa(running),
      invoiceNo: typeof invoiceNo === 'string' ? invoiceNo : null,
    };
  });
  return {
    customer,
    range,
    opening: paisa(opening),
    udhaarGiven: paisa(udhaarGiven),
    paid: paisa(paid),
    closing: paisa(running),
    lines,
  };
}

/** Active customers with a positive balance, largest first. */
export async function pendingUdhaar(ctx: Ctx): Promise<PendingUdhaar[]> {
  requireSession(ctx);
  const rows = await ctx.driver.query<Raw>(
    `SELECT c.*, SUM(le.amount) AS balance,
       MAX(CASE WHEN le.amount > 0 THEN le.created_at END) AS last_credit_at,
       MAX(CASE WHEN le.type = 'payment_received' THEN le.created_at END) AS last_payment_at
     FROM customers c JOIN ledger_entries le ON le.customer_id = c.id
     WHERE c.is_active = 1
     GROUP BY c.id HAVING SUM(le.amount) > 0
     ORDER BY balance DESC, c.name`,
  );
  return rows.map((r): PendingUdhaar => {
    const { balance, last_credit_at: credit, last_payment_at: payment, ...customer } = r;
    return {
      party: mapRow<Customer>(customer),
      balance: paisa(num(balance)),
      lastCreditAt: epochOrNull(credit),
      lastPaymentAt: epochOrNull(payment),
    };
  });
}
