import type {
  BusinessType,
  CheckoutDraft,
  PhoneCondition,
  PosService,
  PtaStatus,
} from '@pos/shared';
import { imeiCheckDigit } from './catalog';
import type { ServiceDeps } from './deps';
import { META, upsertMeta } from './meta';
import { createSeedService, ean13, rs, type SeedSummary } from './seed-common';
import { seedKiryanaDemo } from './seed-kiryana';

export type { SeedSummary } from './seed-common';

export interface SeedOptions {
  /** 'kiryana' loads the grocery demo; anything else (the default) loads the mobile-shop demo. */
  businessType?: BusinessType;
}

interface PhoneSeed {
  brand: string;
  name: string;
  ram: number | null;
  storage: number;
  pta: PtaStatus;
  condition: PhoneCondition;
  cost: number;
  sale: number;
  battery?: number;
}
const PHONES: PhoneSeed[] = [
  {
    brand: 'Samsung',
    name: 'Galaxy A15',
    ram: 4,
    storage: 128,
    pta: 'approved',
    condition: 'new',
    cost: 41_500,
    sale: 44_500,
  },
  {
    brand: 'Samsung',
    name: 'Galaxy A35',
    ram: 8,
    storage: 256,
    pta: 'approved',
    condition: 'new',
    cost: 88_000,
    sale: 94_000,
  },
  {
    brand: 'Samsung',
    name: 'Galaxy A55',
    ram: 8,
    storage: 256,
    pta: 'approved',
    condition: 'new',
    cost: 78_000,
    sale: 85_000,
  },
  {
    brand: 'Samsung',
    name: 'Galaxy S24',
    ram: 8,
    storage: 256,
    pta: 'approved',
    condition: 'new',
    cost: 215_000,
    sale: 229_000,
  },
  {
    brand: 'Infinix',
    name: 'Hot 40i',
    ram: 8,
    storage: 256,
    pta: 'approved',
    condition: 'new',
    cost: 33_500,
    sale: 36_500,
  },
  {
    brand: 'Infinix',
    name: 'Note 40',
    ram: 8,
    storage: 256,
    pta: 'approved',
    condition: 'new',
    cost: 54_000,
    sale: 58_500,
  },
  {
    brand: 'Tecno',
    name: 'Spark 20',
    ram: 8,
    storage: 128,
    pta: 'approved',
    condition: 'new',
    cost: 31_000,
    sale: 34_000,
  },
  {
    brand: 'Tecno',
    name: 'Camon 30',
    ram: 8,
    storage: 256,
    pta: 'approved',
    condition: 'new',
    cost: 56_000,
    sale: 60_500,
  },
  {
    brand: 'Xiaomi',
    name: 'Redmi Note 13',
    ram: 8,
    storage: 256,
    pta: 'approved',
    condition: 'new',
    cost: 52_000,
    sale: 56_000,
  },
  {
    brand: 'Oppo',
    name: 'A18',
    ram: 4,
    storage: 128,
    pta: 'approved',
    condition: 'new',
    cost: 33_000,
    sale: 36_000,
  },
  {
    brand: 'Apple',
    name: 'iPhone 13',
    ram: null,
    storage: 128,
    pta: 'non_pta',
    condition: 'used',
    cost: 118_000,
    sale: 127_000,
    battery: 86,
  },
  {
    brand: 'Apple',
    name: 'iPhone 14 Pro',
    ram: null,
    storage: 256,
    pta: 'jv',
    condition: 'open_box',
    cost: 265_000,
    sale: 282_000,
  },
];
const COLOURS = ['Black', 'Blue', 'White', 'Green'];

interface AccSeed {
  name: string;
  model: string;
  colour: string | null;
  cost: number;
  sale: number;
  qty?: number;
  reorder?: number;
}
const GLASS = 8;
const ACCESSORIES: AccSeed[] = [
  { name: 'Fast Charger 25W Type-C', model: 'Universal', colour: 'Black', cost: 900, sale: 1_500 },
  { name: 'Fast Charger 25W Type-C', model: 'Universal', colour: 'White', cost: 900, sale: 1_500 },
  { name: 'Fast Charger 33W', model: 'Universal', colour: 'White', cost: 1_300, sale: 2_100 },
  { name: 'GaN Charger 65W', model: 'Universal', colour: 'Black', cost: 3_200, sale: 4_800 },
  { name: 'iPhone Charger 20W', model: 'iPhone', colour: 'White', cost: 2_200, sale: 3_200 },
  { name: 'Car Charger 30W', model: 'Universal', colour: 'Black', cost: 700, sale: 1_200 },
  { name: 'Cable Type-C 1m', model: 'Universal', colour: 'Black', cost: 250, sale: 500, qty: 20 },
  { name: 'Cable Type-C 1m', model: 'Universal', colour: 'White', cost: 250, sale: 500, qty: 20 },
  { name: 'Cable Lightning 1m', model: 'iPhone', colour: 'White', cost: 600, sale: 1_100 },
  {
    name: 'Cable Micro-USB 1m',
    model: 'Universal',
    colour: 'Black',
    cost: 150,
    sale: 350,
    qty: 20,
  },
  { name: 'Wired Earphones', model: 'Universal', colour: 'White', cost: 300, sale: 600, qty: 15 },
  { name: 'Earbuds Pro', model: 'Universal', colour: 'Black', cost: 1_800, sale: 2_800, qty: 8 },
  {
    name: 'Power Bank 10000mAh',
    model: 'Universal',
    colour: 'Black',
    cost: 2_600,
    sale: 3_800,
    qty: 6,
  },
  {
    name: 'Power Bank 20000mAh',
    model: 'Universal',
    colour: 'Black',
    cost: 4_200,
    sale: 5_900,
    qty: 2,
  },
  {
    name: 'Tempered Glass',
    model: 'iPhone 13',
    colour: 'Clear',
    cost: 150,
    sale: 500,
    qty: 14,
    reorder: GLASS,
  },
  {
    name: 'Tempered Glass',
    model: 'iPhone 14 Pro',
    colour: 'Clear',
    cost: 180,
    sale: 600,
    qty: 3,
    reorder: GLASS,
  },
  {
    name: 'Tempered Glass',
    model: 'Galaxy A15',
    colour: 'Clear',
    cost: 100,
    sale: 400,
    qty: 14,
    reorder: GLASS,
  },
  {
    name: 'Tempered Glass',
    model: 'Galaxy A55',
    colour: 'Clear',
    cost: 120,
    sale: 450,
    qty: 14,
    reorder: GLASS,
  },
  {
    name: 'Tempered Glass',
    model: 'Redmi Note 13',
    colour: 'Clear',
    cost: 100,
    sale: 400,
    qty: 14,
    reorder: GLASS,
  },
  { name: 'Back Cover', model: 'Galaxy A55', colour: 'Black', cost: 200, sale: 600, qty: 8 },
  { name: 'Back Cover', model: 'iPhone 13', colour: 'Navy', cost: 350, sale: 900, qty: 8 },
  { name: 'Back Cover', model: 'Infinix Note 40', colour: 'Clear', cost: 150, sale: 450, qty: 8 },
  { name: 'Memory Card 64GB', model: 'Universal', colour: null, cost: 900, sale: 1_400, qty: 10 },
  { name: 'OTG Adapter', model: 'Universal', colour: null, cost: 80, sale: 250, qty: 25 },
  { name: 'Phone Stand', model: 'Universal', colour: 'Black', cost: 200, sale: 450, qty: 10 },
];
const HAFEEZ_ACCESSORIES = 13; // first 13 accessories come from Hafeez Centre, the rest from Karachi

const accKey = (a: { name: string; model: string; colour: string | null }): string =>
  `${a.name}|${a.model}|${a.colour ?? ''}`;

/**
 * Creates a complete demo shop through the REAL service (so outbox rows and the hash chain are exercised).
 * Uses its own service instance with a stepping clock and a deterministic id generator.
 * Throws ALREADY_SETUP if the shop exists.
 */
export async function seedDemoData(
  deps: ServiceDeps,
  options: SeedOptions = {},
): Promise<SeedSummary> {
  if (options.businessType === 'kiryana') return seedKiryanaDemo(deps);
  const svc: PosService = createSeedService(deps);

  await svc.setup.firstRun({
    shopName: 'Al-Madina Mobile Centre',
    branchName: 'Main Counter',
    invoicePrefix: 'A',
    owner: { username: 'owner', displayName: 'Owner', pin: '1234' },
  });
  const m = upsertMeta(META.demoData, '1');
  await deps.driver.batch([m]);

  await svc.auth.login('owner', '1234');
  await svc.auth.createUser({
    username: 'manager',
    displayName: 'Manager',
    role: 'manager',
    pin: '2345',
  });
  await svc.auth.createUser({
    username: 'cashier',
    displayName: 'Cashier',
    role: 'cashier',
    pin: '3456',
  });

  const hafeez = await svc.purchasing.createSupplier({
    name: 'Hafeez Centre Traders',
    phone: '03211234567',
  });
  await svc.purchasing.createSupplier({ name: 'Ali Mobile Wholesale', address: 'Rawalpindi' });
  const karachi = await svc.purchasing.createSupplier({
    name: 'Karachi Accessories House',
    address: 'Saddar',
  });

  // accessories (stock arrives with the opening purchases below)
  const variantIds = new Map<string, string>();
  for (const [i, a] of ACCESSORIES.entries()) {
    const v = await svc.catalog.createAccessory({
      product: { brand: 'Generic', name: a.name, category: 'Accessory' },
      sku: `ACC-${String(i + 1).padStart(3, '0')}`,
      barcode: ean13(`8961000${String(i + 1).padStart(5, '0')}`),
      model: a.model,
      colour: a.colour,
      costPrice: rs(a.cost),
      salePrice: rs(a.sale),
      reorderLevel: a.reorder ?? 5,
    });
    variantIds.set(accKey(a), v.variant.id);
  }
  const accLine = (a: AccSeed): { variantId: string; quantity: number; unitCost: number } => ({
    variantId: variantIds.get(accKey(a)) ?? '',
    quantity: a.qty ?? 12,
    unitCost: rs(a.cost),
  });
  const thirty = (total: number): number => Math.floor((total * 3) / 10);

  // OPEN-001: all phones + first accessories from Hafeez, 30% paid in cash
  const hafeezAcc = ACCESSORIES.slice(0, HAFEEZ_ACCESSORIES).map(accLine);
  const hafeezTotal =
    PHONES.reduce((s, p) => s + rs(p.cost), 0) +
    hafeezAcc.reduce((s, l) => s + l.quantity * l.unitCost, 0);
  const open1 = await svc.purchasing.receive({
    supplierId: hafeez.id,
    referenceNo: 'OPEN-001',
    note: 'Opening stock',
    phones: PHONES.map((p, i) => ({
      product: { brand: p.brand, name: p.name, category: 'Smartphone' },
      imei1: `${'35693803'}${String(100_001 + i)}${imeiCheckDigit(`35693803${String(100_001 + i)}`)}`,
      colour: p.battery !== undefined ? 'Blue' : (COLOURS[i % COLOURS.length] ?? null),
      storageGb: p.storage,
      ramGb: p.ram,
      batteryHealthPct: p.battery ?? null,
      ptaStatus: p.pta,
      condition: p.condition,
      costPrice: rs(p.cost),
      salePrice: rs(p.sale),
    })),
    accessories: hafeezAcc,
    paidNow: { method: 'cash', amount: thirty(hafeezTotal) },
  });
  // OPEN-002: the rest from Karachi Accessories House
  const karachiAcc = ACCESSORIES.slice(HAFEEZ_ACCESSORIES).map(accLine);
  const karachiTotal = karachiAcc.reduce((s, l) => s + l.quantity * l.unitCost, 0);
  await svc.purchasing.receive({
    supplierId: karachi.id,
    referenceNo: 'OPEN-002',
    note: 'Opening stock',
    phones: [],
    accessories: karachiAcc,
    paidNow: { method: 'cash', amount: thirty(karachiTotal) },
  });

  // customers
  const bilal = await svc.khata.createCustomer({
    name: 'Bilal Ahmed',
    phone: '03001234567',
    cnic: '3520112345671',
    creditLimit: rs(50_000),
    openingBalance: rs(12_000),
  });
  await svc.khata.createCustomer({ name: 'Ayesha Khan', phone: '03211234567' });
  await svc.khata.createCustomer({
    name: 'Hamza Traders',
    phone: '03331234567',
    creditLimit: rs(200_000),
    openingBalance: rs(45_000),
  });
  await svc.khata.createCustomer({ name: 'Sana Malik', phone: '03451234567' });
  await svc.khata.createCustomer({ name: 'Usman Ali', phone: '03121234567' });

  // sample sales, as the cashier
  svc.auth.logout();
  await svc.auth.login('cashier', '3456');
  const acc = (name: string, model: string, colour: string | null): string =>
    variantIds.get(accKey({ name, model, colour })) ?? '';
  const sellCash = async (draft: CheckoutDraft) => {
    const p = await svc.checkout.preview(draft);
    return svc.checkout.commit({ ...draft, payments: [{ method: 'cash', amount: p.total }] });
  };

  const sale1 = await sellCash({
    lines: [{ variantId: acc('Fast Charger 25W Type-C', 'Universal', 'Black'), quantity: 2 }],
  });
  await sellCash({
    lines: [
      { variantId: acc('Cable Type-C 1m', 'Universal', 'Black'), quantity: 1 },
      { variantId: acc('Tempered Glass', 'iPhone 13', 'Clear'), quantity: 1 },
    ],
  });
  await sellCash({
    lines: [
      { variantId: acc('Wired Earphones', 'Universal', 'White'), quantity: 1 },
      { variantId: acc('OTG Adapter', 'Universal', null), quantity: 2 },
    ],
  });
  // phone with a Rs 500 discount (well inside the cashier's 5% limit)
  await sellCash({
    lines: [{ phoneUnitId: open1.phoneUnitIds[1] ?? '', quantity: 1, discountAmount: rs(500) }],
  });
  // split cash + khata to Bilal
  const splitDraft: CheckoutDraft = {
    lines: [{ phoneUnitId: open1.phoneUnitIds[0] ?? '', quantity: 1 }],
    customerId: bilal.id,
  };
  const splitPreview = await svc.checkout.preview(splitDraft);
  await svc.checkout.commit({
    ...splitDraft,
    payments: [
      { method: 'cash', amount: splitPreview.total - rs(20_000) },
      { method: 'khata', amount: rs(20_000) },
    ],
  });

  // partial return of one charger, as the manager
  svc.auth.logout();
  await svc.auth.login('manager', '2345');
  const line = sale1.lines[0];
  if (line === undefined) throw new Error('seed: sale 1 has no lines');
  const preview = await svc.checkout.previewReturn(sale1.id, [{ lineId: line.id, quantity: 1 }]);
  await svc.checkout.createReturn({
    originalSaleId: sale1.id,
    lines: [{ lineId: line.id, quantity: 1 }],
    refund: preview.suggestedRefund.map((p) => ({ method: p.method, amount: -p.amount })),
    reason: 'Customer changed mind',
  });
  svc.auth.logout();

  return {
    phones: PHONES.length,
    accessories: ACCESSORIES.length,
    customers: 5,
    suppliers: 3,
    sales: 6,
  };
}
