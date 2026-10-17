import type { PhoneCondition, PtaStatus } from '@pos/shared';
import type { SqlDriver } from '../driver';
import { createPosService } from './index';
import { markDemo } from './auth';
import { createCtx } from './context';

const rs = (n: number): number => n * 100;

/** A valid (Luhn) 15-digit demo IMEI. */
function imei(counter: number): string {
  const base = `35693803${String(counter).padStart(6, '0')}`;
  let total = 0;
  for (let i = 0; i < base.length; i++) {
    let d = Number(base[base.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return base + String((10 - (total % 10)) % 10);
}

const PHONES: [
  string,
  string,
  number,
  number,
  PtaStatus,
  PhoneCondition,
  number,
  number,
  string,
][] = [
  ['Samsung', 'Galaxy A15', 4, 128, 'approved', 'new', 41500, 44500, 'Black'],
  ['Samsung', 'Galaxy A35', 8, 256, 'approved', 'new', 88000, 94000, 'Navy'],
  ['Samsung', 'Galaxy A55', 8, 256, 'approved', 'new', 78000, 85000, 'Lilac'],
  ['Samsung', 'Galaxy S24', 8, 256, 'approved', 'new', 215000, 229000, 'Grey'],
  ['Infinix', 'Hot 40i', 8, 256, 'approved', 'new', 33500, 36500, 'Green'],
  ['Infinix', 'Note 40', 8, 256, 'approved', 'new', 54000, 58500, 'Gold'],
  ['Tecno', 'Spark 20', 8, 128, 'approved', 'new', 31000, 34000, 'White'],
  ['Xiaomi', 'Redmi Note 13', 8, 256, 'approved', 'new', 52000, 56000, 'Blue'],
  ['Apple', 'iPhone 13', 4, 128, 'non_pta', 'used', 118000, 127000, 'Midnight'],
  ['Apple', 'iPhone 14 Pro', 6, 256, 'jv', 'open_box', 265000, 282000, 'Purple'],
];

const ACCESSORIES: [string, string, string, string, number, number, number][] = [
  ['Fast Charger 25W Type-C', 'Universal', 'Black', 'CHG-25-BLK', 900, 1500, 14],
  ['Fast Charger 25W Type-C', 'Universal', 'White', 'CHG-25-WHT', 900, 1500, 9],
  ['GaN Charger 65W', 'Universal', 'Black', 'CHG-65-BLK', 3200, 4800, 6],
  ['Cable Type-C 1m', 'Universal', 'Black', 'CBL-C-1M', 250, 500, 40],
  ['Cable Lightning 1m', 'iPhone', 'White', 'CBL-L-1M', 600, 1100, 18],
  ['Wired Earphones', 'Universal', 'White', 'AUD-WRD', 300, 600, 25],
  ['Earbuds Pro', 'Universal', 'Black', 'AUD-EBP', 1800, 2800, 7],
  ['Power Bank 10000mAh', 'Universal', 'Black', 'PWR-10K', 2600, 3800, 8],
  ['Power Bank 20000mAh', 'Universal', 'Black', 'PWR-20K', 4200, 5900, 2],
  ['Tempered Glass', 'iPhone 13', 'Clear', 'GLS-IP13', 150, 500, 30],
  ['Tempered Glass', 'iPhone 14 Pro', 'Clear', 'GLS-IP14P', 180, 600, 3],
  ['Tempered Glass', 'Galaxy A55', 'Clear', 'GLS-A55', 120, 450, 22],
  ['Back Cover', 'Galaxy A55', 'Black', 'CVR-A55', 200, 600, 12],
  ['Memory Card 64GB', 'Universal', '', 'MEM-64', 900, 1400, 10],
];

/**
 * Fills an EMPTY database with the demo shop (users owner/1234, manager/2345, cashier/3456), stock, khata
 * customers and a few sales, all through the public service so every rule and trigger applies.
 */
export async function seedDemoData({ driver }: { driver: SqlDriver }): Promise<void> {
  const s = createPosService({ driver });
  await s.setup.firstRun({
    shopName: 'Al-Madina Mobile Centre',
    branchName: 'Main Counter',
    invoicePrefix: 'A',
    owner: { username: 'owner', displayName: 'Owner', pin: '1234' },
  });
  await markDemo(createCtx({ driver }), true);
  await s.auth.login('owner', '1234');
  await s.settings.update({
    address: 'Shop 12, Hall Road, Lahore',
    phone: '0300-1234567',
    receiptFooter: 'No warranty without this receipt.',
    receiptFooterUr: 'Raseed ke baghair warranty nahi hogi.',
  });
  await s.auth.createUser({
    username: 'manager',
    displayName: 'Manager',
    role: 'manager',
    pin: '2345',
  });
  await s.auth.createUser({
    username: 'cashier',
    displayName: 'Cashier',
    role: 'cashier',
    pin: '3456',
  });

  const sup = await s.purchasing.createSupplier({
    name: 'Hafeez Centre Traders',
    phone: '03211234567',
    openingBalance: rs(185000),
  });
  await s.purchasing.createSupplier({ name: 'Karachi Accessories House', address: 'Saddar' });

  let n = 100;
  for (const [brand, name, ram, gb, pta, cond, cost, sale, colour] of PHONES) {
    n += 1;
    await s.catalog.createPhoneUnit({
      product: { brand, name, category: 'Smartphone' },
      imei1: imei(n),
      colour,
      ramGb: ram,
      storageGb: gb,
      ptaStatus: pta,
      condition: cond,
      costPrice: rs(cost),
      salePrice: rs(sale),
      supplierId: sup.id,
      batteryHealthPct: cond === 'used' ? 86 : null,
    });
  }
  let b = 0;
  for (const [name, model, colour, sku, cost, sale, qty] of ACCESSORIES) {
    b += 1;
    await s.catalog.createAccessory({
      product: { brand: 'Generic', name, category: 'Accessory' },
      sku,
      barcode: `8961000${String(b).padStart(5, '0')}0`,
      model,
      colour: colour || null,
      costPrice: rs(cost),
      salePrice: rs(sale),
      reorderLevel: 5,
      openingQty: qty,
    });
  }

  const bilal = await s.khata.createCustomer({
    name: 'Bilal Ahmed',
    phone: '03001234567',
    cnic: '3520112345671',
    creditLimit: rs(50000),
    openingBalance: rs(12000),
  });
  await s.khata.createCustomer({ name: 'Ayesha Khan', phone: '03211234567' });
  await s.khata.createCustomer({
    name: 'Hamza Traders',
    phone: '03331234567',
    creditLimit: rs(200000),
    openingBalance: rs(45000),
  });
  await s.khata.createCustomer({ name: 'Sana Malik', phone: '03451234567' });

  // a few sales so Sales / Khata / Reports are not empty
  const acc = await s.catalog.listAccessories();
  const phones = await s.catalog.listPhones({ inStock: true });
  const charger = acc.find((v) => v.variant.sku === 'CHG-25-BLK');
  const glass = acc.find((v) => v.variant.sku === 'GLS-A55');
  const cable = acc.find((v) => v.variant.sku === 'CBL-C-1M');
  const a15 = phones.find((p) => p.product.name === 'Galaxy A15');
  if (charger && glass && cable && a15) {
    await s.checkout.commit({
      lines: [{ variantId: charger.variant.id, quantity: 2 }],
      payments: [{ method: 'cash', amount: 2 * charger.variant.salePrice }],
    });
    await s.checkout.commit({
      lines: [
        { variantId: glass.variant.id, quantity: 1 },
        { variantId: cable.variant.id, quantity: 2 },
      ],
      payments: [
        { method: 'jazzcash', amount: glass.variant.salePrice + 2 * cable.variant.salePrice },
      ],
    });
    const price = a15.unit.salePrice - rs(500);
    await s.checkout.commit({
      lines: [{ phoneUnitId: a15.unit.id, quantity: 1, discountAmount: rs(500) }],
      customerId: bilal.id,
      payments: [
        { method: 'cash', amount: rs(20000) },
        { method: 'khata', amount: price - rs(20000) },
      ],
    });
  }
  s.auth.logout();
}
