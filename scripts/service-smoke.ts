/* eslint-disable no-console -- CLI script, console is its output */
/* Smoke test for the PosService (packages/db/src/service). Run: npx tsx scripts/service-smoke.ts */
import { formatPaisa, paisa } from '@pos/core';
import { isServiceError } from '@pos/shared';
import { migrate } from '../packages/db/src/index';
import { createNodeSqliteDriver, loadMigrationsFromDir } from '../packages/db/src/node';
import { createPosService, seedDemoData } from '../packages/db/src/service/index';

const rs = (n: number): string => `Rs ${formatPaisa(paisa(n))}`;
const head = (t: string): void => console.log(`\n=== ${t} ===`);
let failures = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'ok' : 'FAIL'}] ${label}${extra === '' ? '' : ` -> ${extra}`}`);
};
const expectCode = async (
  label: string,
  code: string,
  fn: () => Promise<unknown>,
): Promise<void> => {
  try {
    await fn();
    check(label, false, `no error, expected ${code}`);
  } catch (e) {
    check(
      label,
      isServiceError(e) && e.code === code,
      isServiceError(e) ? `${e.code} ${JSON.stringify(e.details)}` : String(e),
    );
  }
};

const driver = createNodeSqliteDriver();
await migrate(driver, loadMigrationsFromDir());
const svc = createPosService({ driver, pinIterations: 1000 });

head('1. Seed demo data');
const t0 = Date.now();
const seeded = await seedDemoData({ driver, pinIterations: 1000 });
console.log('  seed summary:', JSON.stringify(seeded), `(${Date.now() - t0} ms)`);
check('seed counts', seeded.accessories === 20 && seeded.customers === 5 && seeded.suppliers === 2);
check('isSetUp', await svc.setup.isSetUp());
const shop = await svc.setup.getShop();
check('shop is demo', shop.isDemo, `${shop.branchName}, prefix ${shop.invoicePrefix}`);
await expectCode('seeding twice is refused', 'ALREADY_SETUP', () =>
  seedDemoData({ driver, pinIterations: 1000 }),
);
console.log(
  '  login users:',
  (await svc.auth.listLoginUsers()).map((u) => `${u.username}(${u.role})`).join(', '),
);

head('2. Login as cashier');
await expectCode('wrong PIN', 'INVALID_CREDENTIALS', () => svc.auth.login('cashier', '0000'));
const session = await svc.auth.login('cashier', '3456');
check(
  'cashier session',
  session.user.role === 'cashier' && svc.auth.can('sell') && !svc.auth.can('view_reports'),
);
await expectCode('cashier cannot create items', 'FORBIDDEN', () =>
  svc.catalog.createAccessory({
    product: { brand: 'X', name: 'Y' },
    sku: 'X-Y',
    costPrice: 1,
    salePrice: 2,
  }),
);

head('3. Sale with split cash + khata');
const customers = await svc.khata.listCustomers();
const haji = customers.find((c) => c.party.name === 'Haji Rafiq');
if (haji === undefined) throw new Error('Haji Rafiq missing');
const soap = (await svc.catalog.search('lux soap', {}))[0];
if (soap === undefined) throw new Error('no soap found by name');
const scanned = await svc.catalog.search(soap.item.variant.barcode ?? '');
check(
  'barcode scan returns one exact hit',
  scanned.length === 1 && scanned[0]?.matchedBy === 'barcode',
);
const draft = {
  lines: [{ variantId: soap.item.variant.id, quantity: 3 }],
  customerId: haji.party.id,
};
const preview = await svc.checkout.preview(draft);
console.log(
  `  preview: ${preview.lines[0]?.description} x3 total ${rs(preview.total)}, customer balance ${rs(preview.customerBalance ?? 0)}`,
);
const khataPart = 10_000;
const splitPayments = [
  { method: 'cash' as const, amount: preview.total - khataPart },
  { method: 'khata' as const, amount: khataPart },
];
const inv1 = await svc.checkout.commit({ ...draft, payments: splitPayments });
console.log(
  `  ${inv1.invoiceNo} seq ${inv1.seq} total ${rs(inv1.total)} payments ${inv1.payments.map((p) => `${p.method} ${rs(p.amount)}`).join(' + ')}`,
);
const ledger = await svc.khata.getLedger(haji.party.id);
check(
  'khata ledger got +khata part',
  ledger.lines[0]?.entry.type === 'sale_credit' && ledger.lines[0].entry.amount === khataPart,
);
check(
  'running balance = 10,000 + part',
  ledger.balance === 1_000_000 + khataPart,
  rs(ledger.balance),
);
const again = await svc.checkout.commit({
  ...draft,
  saleId: inv1.id,
  payments: splitPayments,
});
check('idempotent re-commit by saleId returns stored invoice', again.id === inv1.id);
await expectCode('payments must match total', 'PAYMENT_MISMATCH', () =>
  svc.checkout.commit({ ...draft, payments: [{ method: 'cash', amount: 1 }] }),
);
await expectCode('khata without customer', 'KHATA_NEEDS_CUSTOMER', () =>
  svc.checkout.commit({
    lines: draft.lines,
    payments: [{ method: 'khata', amount: preview.total }],
  }),
);

head('4. Cashier discount approval with a manager token');
const surf = (await svc.catalog.search('surf excel', { inStockOnly: true }))[0];
if (surf === undefined) throw new Error('no Surf Excel in stock');
const gross = surf.item.variant.salePrice;
const big = Math.floor((gross * 600) / 10_000); // 6% > the 5% cashier limit
const pDraft = { lines: [{ variantId: surf.item.variant.id, quantity: 1, discountAmount: big }] };
const pPrev = await svc.checkout.preview(pDraft);
check(
  'preview flags approval',
  pPrev.needsApproval.includes('discount'),
  `${pPrev.effectiveDiscountBps} bps`,
);
const pay = [{ method: 'cash' as const, amount: pPrev.total }];
await expectCode('commit without token', 'APPROVAL_REQUIRED', () =>
  svc.checkout.commit({ ...pDraft, payments: pay }),
);
await expectCode('cashier PIN is not an approver PIN', 'APPROVAL_INVALID', () =>
  svc.auth.requestApproval('3456'),
);
const grant = await svc.auth.requestApproval('2345');
check('grant from manager', grant.approverUsername === 'manager');
const approved = await svc.checkout.commit({
  ...pDraft,
  payments: pay,
  approvalToken: grant.token,
});
check(
  'approved sale note ends with approved:manager',
  approved.note?.endsWith('approved:manager') === true,
  approved.note ?? '',
);
await expectCode('token is single use', 'APPROVAL_REQUIRED', () =>
  svc.checkout.commit({ ...pDraft, payments: pay, approvalToken: grant.token }),
);
await expectCode('more than on hand is refused', 'STOCK_INSUFFICIENT', () =>
  svc.checkout.preview({ lines: [{ variantId: surf.item.variant.id, quantity: 10_000 }] }),
);

head('5. Return (manager)');
svc.auth.logout();
await expectCode('no session -> NOT_AUTHENTICATED', 'NOT_AUTHENTICATED', () =>
  svc.checkout.preview(draft),
);
await svc.auth.login('manager', '2345');
const line = inv1.lines[0];
if (line === undefined) throw new Error('no line');
const rp = await svc.checkout.previewReturn(inv1.id, [{ lineId: line.id, quantity: 2 }]);
console.log(
  `  return preview total ${rs(rp.total)}, suggested refund ${rp.suggestedRefund.map((p) => `${p.method} ${rs(p.amount)}`).join(' + ')}`,
);
const ret = await svc.checkout.createReturn({
  originalSaleId: inv1.id,
  lines: [{ lineId: line.id, quantity: 2 }],
  refund: rp.suggestedRefund.map((p) => ({ method: p.method, amount: -p.amount })),
  reason: 'Damaged soap',
});
console.log(`  ${ret.invoiceNo} kind ${ret.kind} total ${rs(ret.total)} seq ${ret.seq}`);
check(
  'return is negative and chained',
  ret.total === rp.total && ret.kind === 'return' && ret.seq === approved.seq + 1,
);
await expectCode('over-return', 'ALREADY_RETURNED', () =>
  svc.checkout.createReturn({
    originalSaleId: inv1.id,
    lines: [{ lineId: line.id, quantity: 2 }],
    refund: [],
    reason: 'x',
  }),
);
const after = await svc.catalog.search(soap.item.variant.barcode ?? '');
check(
  'stock came back',
  after[0]?.item.onHand === soap.item.onHand - 3 + 2,
  `${soap.item.onHand} -> ${after[0]?.item.onHand ?? '?'}`,
);

head('6. Daily report summary');
const sum = await svc.reports.summary({ fromMs: 0, toMs: Date.now() + 86_400_000 });
console.log(
  `  sales ${sum.salesCount}, returns ${sum.returnsCount}, gross ${rs(sum.grossSales)}, discounts ${rs(sum.discounts)}, net ${rs(sum.netSales)}`,
);
console.log(
  `  returns ${rs(sum.returnsTotal)}, revenue ${rs(sum.netRevenue)}, cogs ${rs(sum.estimatedCogs)}, profit ${rs(sum.estimatedProfit)}`,
);
console.log(
  `  by method: ${Object.entries(sum.byMethod)
    .map(([k, v]) => `${k} ${rs(v)}`)
    .join(', ')}`,
);
console.log(
  `  khata collected ${rs(sum.khataCollected)}, cash in drawer ${rs(sum.cashInDrawer)}, low stock items ${sum.lowStock.length}`,
);
check(
  'report: 7 sales, 2 returns (seed 1 + ours 1)',
  sum.salesCount === 7 && sum.returnsCount === 2,
  `${sum.salesCount}/${sum.returnsCount}`,
);
check(
  'report: netRevenue = netSales - returns',
  sum.netRevenue === sum.netSales - sum.returnsTotal,
);
check(
  'report: profit = revenue - cogs',
  sum.estimatedProfit === sum.netRevenue - sum.estimatedCogs,
);
check('report: low stock is non-empty', sum.lowStock.length > 0);

head('7. Integrity');
const chain = await svc.integrity.verifyChain();
console.log('  chain:', JSON.stringify(chain).slice(0, 160));
check(
  'verifyChain ok',
  chain.ok && chain.count === 9,
  chain.ok ? `${chain.count} invoices` : chain.reason,
);
const checks = await svc.integrity.checks();
check(
  'integrity checks clean',
  checks.salePaymentMismatch === 0 && checks.saleLineMismatch === 0,
  JSON.stringify(checks),
);
await driver.exec('DROP TRIGGER trg_sales_no_update');
await driver.exec('UPDATE sales SET created_at = created_at - 1 WHERE seq = 1');
const broken = await svc.integrity.verifyChain();
check('tampering detected at seq 1', !broken.ok && broken.seq === 1, JSON.stringify(broken));
await driver.exec('UPDATE sales SET created_at = created_at + 1 WHERE seq = 1');
check('chain ok again after restoring', (await svc.integrity.verifyChain()).ok);

head('8. Two concurrent commits get distinct seq');
const [a, b] = await Promise.all([
  svc.checkout.commit({
    lines: [{ variantId: soap.item.variant.id, quantity: 1 }],
    payments: [{ method: 'cash', amount: soap.item.variant.salePrice }],
  }),
  svc.checkout.commit({
    lines: [{ variantId: soap.item.variant.id, quantity: 1 }],
    payments: [{ method: 'cash', amount: soap.item.variant.salePrice }],
  }),
]);
console.log(`  seqs ${a.seq} and ${b.seq}`);
check('distinct, consecutive seq', a.seq !== b.seq && Math.abs(a.seq - b.seq) === 1);
const many = await Promise.all(
  Array.from({ length: 5 }, () =>
    svc.checkout.commit({
      lines: [{ variantId: soap.item.variant.id, quantity: 1 }],
      payments: [{ method: 'cash', amount: soap.item.variant.salePrice }],
    }),
  ),
);
const seqs = many.map((i) => i.seq).sort((x, y) => x - y);
check(
  '5 concurrent commits are gapless',
  seqs.every((s, i) => i === 0 || s === (seqs[i - 1] ?? 0) + 1),
  seqs.join(','),
);
check('chain still valid', (await svc.integrity.verifyChain()).ok);

head('9. Licence hook and outbox');
await svc.catalog.adjustStock({
  variantId: soap.item.variant.id,
  delta: 20,
  reason: 'smoke restock',
});
const blocked = createPosService({
  driver,
  pinIterations: 1000,
  assertCanSell: () => Promise.reject(Object.assign(new Error('x'), {})),
});
await blocked.auth.login('manager', '2345');
const before = (await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM sales'))[0]?.n ?? 0;
await expectCode('hook failure blocks the write', 'INTERNAL', () =>
  blocked.checkout.commit({
    lines: [{ variantId: soap.item.variant.id, quantity: 1 }],
    payments: [{ method: 'cash', amount: soap.item.variant.salePrice }],
  }),
);
const afterN = (await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM sales'))[0]?.n ?? 0;
check('nothing was written', before === afterN);
const ob = await driver.query<{ entity_type: string; n: number }>(
  'SELECT entity_type, COUNT(*) AS n FROM outbox GROUP BY entity_type ORDER BY entity_type',
);
console.log('  outbox:', ob.map((r) => `${r.entity_type}=${r.n}`).join(' '));
check('outbox has sale rows', (ob.find((r) => r.entity_type === 'sale')?.n ?? 0) === 16);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
driver.close();
process.exit(failures === 0 ? 0 : 1);
