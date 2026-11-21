/* eslint-disable no-console -- CLI script, console is its output */
/* Demo: runs the real engine (migrations, money, stock ledger, hash-chained invoices) in memory.
   Run:  npx tsx scripts/demo.ts   (from C:\dev\point-of-sale) */
import { GENESIS_HASH, InvoiceSchema, type Invoice, type UnsealedInvoice } from '@pos/shared';
import {
  applyPercentDiscount,
  assertPaymentsMatchTotal,
  createUuidV7Generator,
  formatInvoiceNo,
  formatPaisa,
  paisa,
  saleTotals,
  sealInvoice,
  verifyChain,
} from '@pos/core';
import { camelizeKeys, migrate } from '../packages/db/src/index';
import { createNodeSqliteDriver, loadMigrationsFromDir } from '../packages/db/src/node';

const gen = createUuidV7Generator();
const id = (): string => gen();
const rs = (n: number): string => `Rs ${formatPaisa(paisa(n))}`;
const head = (t: string): void => console.log(`\n=== ${t} ===`);
const now = Date.now();

const db = createNodeSqliteDriver();

head('1. Database + migrations');
const applied = await migrate(db, loadMigrationsFromDir());
const tables = await db.query<{ n: number }>(
  "select count(*) n from sqlite_master where type='table' and name not like 'sqlite_%'",
);
const triggers = await db.query<{ n: number }>(
  "select count(*) n from sqlite_master where type='trigger'",
);
console.log(`migrations applied: ${applied.join(', ')}`);
console.log(`tables: ${tables[0]?.n}, protection triggers: ${triggers[0]?.n}`);

head('2. Shop setup (branch, cashier, customer, supplier, products)');
const branch = id(),
  user = id(),
  customer = id(),
  supplier = id();
const device = id();
const ITEMS = {
  rice: {
    product: id(),
    variant: id(),
    brand: 'Guard',
    name: 'Basmati Rice 5kg',
    category: 'Rice',
    sku: 'RICE-5KG',
    barcode: '8961234500017',
    cost: 250_000,
    price: 299_950,
    bought: 4,
  },
  tea: {
    product: id(),
    variant: id(),
    brand: 'Tapal',
    name: 'Danedar 190g',
    category: 'Tea',
    sku: 'TEA-190G',
    barcode: '8961234500024',
    cost: 38_000,
    price: 45_000,
    bought: 10,
  },
} as const;
type ItemKey = keyof typeof ITEMS;
const itemList = Object.values(ITEMS);
await db.batch([
  { sql: 'insert into branches values (?,?,?)', params: [branch, 'Main Counter', now] },
  {
    sql: 'insert into users values (?,?,?,?,?,1,?,?)',
    params: [user, 'ali', 'Ali (Cashier)', 'cashier', 'pin-hash', now, now],
  },
  {
    sql: 'insert into customers (id,name,phone,cnic,credit_limit,created_at,updated_at) values (?,?,?,?,?,?,?)',
    params: [customer, 'Bilal Ahmed', '03001234567', '3520112345671', 5_000_000, now, now],
  },
  {
    sql: 'insert into suppliers (id,name,phone,created_at,updated_at) values (?,?,?,?,?)',
    params: [supplier, 'Mandi Wholesale Traders', '03211234567', now, now],
  },
  ...itemList.flatMap((it) => [
    {
      sql: 'insert into products (id,kind,brand,name,category,created_at,updated_at) values (?,?,?,?,?,?,?)',
      params: [it.product, 'accessory', it.brand, it.name, it.category, now, now],
    },
    {
      sql: `insert into accessory_variants (id,product_id,sku,barcode,cost_price,sale_price,reorder_level,created_at,updated_at)
            values (?,?,?,?,?,?,?,?,?)`,
      params: [it.variant, it.product, it.sku, it.barcode, it.cost, it.price, 3, now, now],
    },
  ]),
]);
for (const it of itemList)
  console.log(
    `${it.brand} ${it.name}: SKU ${it.sku}, barcode ${it.barcode}, sale price`,
    rs(it.price),
  );

head('3. Stock purchase (ledger entries, not a counter)');
const purchase = id();
await db.batch([
  {
    sql: 'insert into purchases values (?,?,?,?,?,?,?,?,?)',
    params: [
      purchase,
      supplier,
      branch,
      'purchase',
      'INV-9001',
      itemList.reduce((sum, it) => sum + it.bought * it.cost, 0),
      null,
      user,
      now,
    ],
  },
  ...itemList.map((it) => ({
    sql: `insert into stock_movements (id,branch_id,type,variant_id,quantity,unit_cost,ref_type,ref_id,created_by,created_at)
          values (?,?,?,?,?,?,?,?,?,?)`,
    params: [
      id(),
      branch,
      'purchase',
      it.variant,
      it.bought,
      it.cost,
      'purchase',
      purchase,
      user,
      now,
    ],
  })),
]);
const onHand = async (): Promise<string> => {
  const parts: string[] = [];
  for (const it of itemList) {
    const v = await db.query<{ on_hand: number }>(
      'select on_hand from v_variant_on_hand where variant_id=?',
      [it.variant],
    );
    parts.push(`${it.name} on hand: ${v[0]?.on_hand ?? 0}`);
  }
  return parts.join(', ');
};
console.log(await onHand());

/** Builds, validates, hashes and atomically commits one invoice (+ stock, ledger). */
let seq = 0;
let prevHash: string = GENESIS_HASH;
async function sell(opts: {
  lines: { item: ItemKey; qty: number; discountBps?: number }[];
  cashPaisa: number;
  khata: boolean;
}): Promise<Invoice> {
  seq += 1;
  const saleId = id();
  const priced = opts.lines.map((l) => {
    const unitPrice = paisa(ITEMS[l.item].price);
    const gross = paisa(unitPrice * l.qty);
    const discountAmount = l.discountBps
      ? applyPercentDiscount(gross, l.discountBps).discount
      : paisa(0);
    return { ...l, unitPrice, quantity: l.qty, discountAmount };
  });
  const totals = saleTotals(priced, paisa(0));
  const payments = [{ method: 'cash' as const, amount: paisa(opts.cashPaisa) }];
  if (opts.khata)
    payments.push({ method: 'khata' as never, amount: paisa(totals.total - opts.cashPaisa) });
  assertPaymentsMatchTotal(totals.total, payments);

  const unsealed = {
    id: saleId,
    deviceId: device,
    seq,
    invoiceNo: formatInvoiceNo('A', seq),
    kind: 'sale',
    originalSaleId: null,
    branchId: branch,
    customerId: opts.khata ? customer : null,
    cashierId: user,
    subtotal: totals.subtotal,
    discountTotal: paisa(0),
    total: totals.total,
    note: null,
    createdAt: now + seq,
    hashVersion: 1,
    lines: priced.map((l, i) => ({
      id: id(),
      saleId,
      lineNo: i + 1,
      productId: ITEMS[l.item].product,
      variantId: ITEMS[l.item].variant,
      description: `${ITEMS[l.item].brand} ${ITEMS[l.item].name}`,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      costPrice: paisa(ITEMS[l.item].cost),
      discountAmount: l.discountAmount,
      lineTotal: paisa(l.unitPrice * l.quantity - l.discountAmount),
      createdAt: now + seq,
    })),
    payments: payments.map((p) => ({
      id: id(),
      saleId,
      method: p.method,
      amount: p.amount,
      reference: null,
      createdAt: now + seq,
    })),
  } as unknown as UnsealedInvoice;

  const invoice = InvoiceSchema.parse(sealInvoice(prevHash, unsealed));
  const s = invoice;
  await db.batch([
    {
      sql: `insert into sales (id,device_id,seq,invoice_no,kind,original_sale_id,branch_id,customer_id,cashier_id,
            subtotal,discount_total,total,note,created_at,hash_version,prev_hash,hash) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        s.id,
        s.deviceId,
        s.seq,
        s.invoiceNo,
        s.kind,
        s.originalSaleId,
        s.branchId,
        s.customerId,
        s.cashierId,
        s.subtotal,
        s.discountTotal,
        s.total,
        s.note,
        s.createdAt,
        s.hashVersion,
        s.prevHash,
        s.hash,
      ],
    },
    ...s.lines.flatMap((l) => [
      {
        sql: `insert into sale_lines (id,sale_id,line_no,product_id,variant_id,description,quantity,
              unit_price,cost_price,discount_amount,line_total,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          l.id,
          l.saleId,
          l.lineNo,
          l.productId,
          l.variantId,
          l.description,
          l.quantity,
          l.unitPrice,
          l.costPrice,
          l.discountAmount,
          l.lineTotal,
          l.createdAt,
        ],
      },
      {
        sql: `insert into stock_movements (id,branch_id,type,variant_id,quantity,ref_type,ref_id,created_by,created_at)
              values (?,?,?,?,?,?,?,?,?)`,
        params: [id(), branch, 'sale', l.variantId, -l.quantity, 'sale', s.id, user, l.createdAt],
      },
    ]),
    ...s.payments.map((p) => ({
      sql: 'insert into payments (id,sale_id,method,amount,reference,created_at) values (?,?,?,?,?,?)',
      params: [p.id, p.saleId, p.method, p.amount, p.reference, p.createdAt],
    })),
    ...(opts.khata
      ? [
          {
            sql: `insert into ledger_entries (id,customer_id,type,amount,sale_id,created_by,created_at) values (?,?,?,?,?,?,?)`,
            params: [
              id(),
              customer,
              'sale_credit',
              totals.total - opts.cashPaisa,
              s.id,
              user,
              s.createdAt,
            ],
          },
        ]
      : []),
  ]);
  prevHash = s.hash;
  return s;
}

head('4. Sale #1: 2 rice bags (5% discount) + 2 tea packs, part cash / part khata');
const inv1 = await sell({
  lines: [
    { item: 'rice', qty: 2, discountBps: 500 },
    { item: 'tea', qty: 2 },
  ],
  cashPaisa: 500_000,
  khata: true,
});
console.log(`${inv1.invoiceNo}: subtotal ${rs(inv1.subtotal)}, total ${rs(inv1.total)}`);
console.log(`  paid: ${inv1.payments.map((p) => `${p.method} ${rs(p.amount)}`).join(' + ')}`);
console.log(`  hash: ${inv1.hash.slice(0, 16)}...  (prev: ${inv1.prevHash.slice(0, 8)}...)`);

head('5. Sale #2: 3 tea packs, cash');
const inv2 = await sell({ lines: [{ item: 'tea', qty: 3 }], cashPaisa: 135_000, khata: false });
console.log(`${inv2.invoiceNo}: total ${rs(inv2.total)}`);
console.log(
  `  hash: ${inv2.hash.slice(0, 16)}...  (prev: ${inv2.prevHash.slice(0, 16)}... = sale #1's hash)`,
);

head('6. Stock and khata, derived from the ledgers');
console.log(await onHand(), '(rice 4 - 2 = 2, tea 10 - 2 - 3 = 5)');
const bal = await db.query<{ balance: number }>(
  'select balance from v_customer_balance where customer_id=?',
  [customer],
);
console.log(`Bilal Ahmed owes: ${rs(bal[0]?.balance ?? 0)}`);

const tryIt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
    console.log(`  [!!] ${label}: ALLOWED (should have been blocked)`);
  } catch (e) {
    console.log(`  [blocked] ${label}\n            -> ${(e as Error).message}`);
  }
};

head('7. Fraud attempts');
await tryIt('edit a finished invoice total', () =>
  db.query('update sales set total = 1 where seq = 1'),
);
await tryIt('delete an invoice', () => db.query('delete from sales where seq = 1'));
await tryIt('delete a stock movement', () => db.query('delete from stock_movements'));
await tryIt('a "sale" movement that adds stock instead of removing it', () =>
  db.query(
    `insert into stock_movements (id,branch_id,type,variant_id,quantity,ref_type,ref_id,created_by,created_at)
     values (?,?,?,?,?,?,?,?,?)`,
    [id(), branch, 'sale', ITEMS.rice.variant, 1, 'sale', inv1.id, user, now],
  ),
);
await tryIt('khata payment on a walk-in sale', () =>
  db.query('insert into payments (id,sale_id,method,amount,created_at) values (?,?,?,?,?)', [
    id(),
    inv2.id,
    'khata',
    100,
    now,
  ]),
);

head('8. Hash chain check');
const readChain = async (): Promise<Invoice[]> => {
  const sales = await db.query<Record<string, unknown>>('select * from sales order by seq');
  const out: Invoice[] = [];
  for (const row of sales) {
    const lines = await db.query<Record<string, unknown>>(
      'select * from sale_lines where sale_id=? order by line_no',
      [row.id as string],
    );
    const pays = await db.query<Record<string, unknown>>('select * from payments where sale_id=?', [
      row.id as string,
    ]);
    out.push(
      InvoiceSchema.parse({
        ...camelizeKeys<Record<string, unknown>>(row),
        lines: lines.map((l) => camelizeKeys(l)),
        payments: pays.map((p) => camelizeKeys(p)),
      }),
    );
  }
  return out;
};
const before = verifyChain(await readChain());
console.log(
  'untouched database  ->',
  before.ok ? `OK (${before.count} invoices)` : `BROKEN: ${before.reason}`,
);

console.log(
  '\nNow an insider switches off the safety triggers and back-dates invoice #1 by one day...',
);
await db.exec('drop trigger trg_sales_no_update');
await db.exec('update sales set created_at = created_at - 86400000 where seq = 1');
const after = verifyChain(await readChain());
console.log(
  'after tampering     ->',
  after.ok ? 'OK (not detected!)' : `DETECTED: ${after.reason} at invoice #${after.index + 1}`,
);
console.log('\nDone. Everything above ran on the real code, in memory (nothing saved to disk).');
db.close();
