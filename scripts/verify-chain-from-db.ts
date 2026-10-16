/* eslint-disable no-console -- CLI script, console is its output */
/* Cross-language proof: opens a pos.db (e.g. the one the C# shell wrote) and runs the TypeScript hash-chain verifier
   over it. If C# and TypeScript ever disagree on the canonical form, this fails.
   Run:  npx tsx scripts/verify-chain-from-db.ts "%LOCALAPPDATA%\AbuzarClone\pos.db"   (copy the file first if the app is open) */
import { existsSync } from 'node:fs';
import { InvoiceSchema, type Invoice } from '@pos/shared';
import { verifyChain } from '@pos/core';
import { camelizeKeys } from '../packages/db/src/index';
import { createNodeSqliteDriver } from '../packages/db/src/node';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('usage: npx tsx scripts/verify-chain-from-db.ts <path-to-pos.db>');
  process.exit(2);
}

const db = createNodeSqliteDriver(file);
type Raw = Record<string, unknown>;

const devices = await db.query<{ device_id: string }>('SELECT DISTINCT device_id FROM sales');
let failed = false;
for (const { device_id: deviceId } of devices) {
  const sales = await db.query<Raw>('SELECT * FROM sales WHERE device_id = ? ORDER BY seq', [
    deviceId,
  ]);
  const chain: Invoice[] = [];
  for (const row of sales) {
    const id = row.id as string;
    const lines = await db.query<Raw>(
      'SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY line_no',
      [id],
    );
    const payments = await db.query<Raw>('SELECT * FROM payments WHERE sale_id = ?', [id]);
    chain.push(
      InvoiceSchema.parse({
        ...camelizeKeys<Raw>(row),
        lines: lines.map((l) => camelizeKeys<Raw>(l)),
        payments: payments.map((p) => camelizeKeys<Raw>(p)),
      }),
    );
  }
  const result = verifyChain(chain);
  if (result.ok)
    console.log(
      `device ${deviceId}: ${result.count} invoices, chain OK, head ${result.headHash.slice(0, 16)}…`,
    );
  else {
    failed = true;
    console.error(
      `device ${deviceId}: CHAIN BROKEN (${result.reason}) at index ${result.index}, invoice ${result.invoiceId ?? '?'}`,
    );
    console.error(`  expected ${result.expected}\n  actual   ${result.actual}`);
  }
}
db.close();
if (devices.length === 0) console.log('no invoices in this database yet');
process.exit(failed ? 1 : 0);
