import { lineGross, pktDate, unitScaleFor, type CheckoutDraft, type UnitLabel } from '@pos/shared';
import type { ServiceDeps } from './deps';
import { META, upsertMeta } from './meta';
import { createSeedService, ean13, rs, type SeedSummary } from './seed-common';

const DAY_MS = 86_400_000;

/** One delivery of a perishable item; `days` is the shelf life left today (negative = already expired). */
interface BatchSeed {
  no: string;
  days: number;
  /** In the priced unit, like Item.qty. */
  qty: number;
}

interface Item {
  /** Unique within the demo; also the lookup key for the sample sales. */
  name: string;
  /** 'pcs' = packed, sold by barcode; 'kg' / 'L' = loose, sold by weight or volume. */
  unit: UnitLabel;
  /** Per priced unit (per piece, per kg, per litre), in rupees. */
  cost: number;
  sale: number;
  /** Opening stock in the priced unit: pieces, kg or litres. */
  qty: number;
  /** Alert level in the priced unit. */
  reorder: number;
  supplier: 'mandi' | 'distributor';
  /** Perishable items arrive in batches with an expiry date; their quantities add up to `qty`. */
  batches?: BatchSeed[];
}

const ITEMS: Item[] = [
  // loose goods from the mandi wholesaler
  {
    name: 'Chini (sugar)',
    unit: 'kg',
    cost: 250,
    sale: 285.5,
    qty: 50,
    reorder: 10,
    supplier: 'mandi',
  },
  {
    name: 'Atta (flour)',
    unit: 'kg',
    cost: 135,
    sale: 150,
    qty: 80,
    reorder: 20,
    supplier: 'mandi',
  },
  {
    name: 'Chawal Basmati',
    unit: 'kg',
    cost: 330,
    sale: 380,
    qty: 40,
    reorder: 10,
    supplier: 'mandi',
  },
  { name: 'Daal Chana', unit: 'kg', cost: 270, sale: 310, qty: 25, reorder: 8, supplier: 'mandi' },
  { name: 'Daal Masoor', unit: 'kg', cost: 290, sale: 330, qty: 4, reorder: 8, supplier: 'mandi' },
  { name: 'Namak (salt)', unit: 'kg', cost: 40, sale: 60, qty: 15, reorder: 5, supplier: 'mandi' },
  {
    name: 'Cooking Oil (loose)',
    unit: 'L',
    cost: 520,
    sale: 580,
    qty: 30,
    reorder: 10,
    supplier: 'mandi',
  },
  { name: 'Doodh (milk)', unit: 'L', cost: 180, sale: 210, qty: 6, reorder: 10, supplier: 'mandi' },
  // packed goods from the distributor
  {
    name: 'Lipton Yellow Label 190g',
    unit: 'pcs',
    cost: 410,
    sale: 450,
    qty: 20,
    reorder: 6,
    supplier: 'distributor',
  },
  {
    name: 'Tapal Danedar 190g',
    unit: 'pcs',
    cost: 395,
    sale: 430,
    qty: 20,
    reorder: 6,
    supplier: 'distributor',
  },
  {
    name: 'Surf Excel 1kg',
    unit: 'pcs',
    cost: 650,
    sale: 720,
    qty: 12,
    reorder: 4,
    supplier: 'distributor',
  },
  {
    name: 'Lux Soap 100g',
    unit: 'pcs',
    cost: 95,
    sale: 110,
    qty: 36,
    reorder: 12,
    supplier: 'distributor',
  },
  {
    name: 'Lifebuoy Soap 100g',
    unit: 'pcs',
    cost: 90,
    sale: 105,
    qty: 36,
    reorder: 12,
    supplier: 'distributor',
  },
  {
    name: 'Rooh Afza 800ml',
    unit: 'pcs',
    cost: 520,
    sale: 580,
    qty: 8,
    reorder: 3,
    supplier: 'distributor',
  },
  {
    name: 'Shan Biryani Masala',
    unit: 'pcs',
    cost: 105,
    sale: 125,
    qty: 30,
    reorder: 10,
    supplier: 'distributor',
  },
  {
    name: 'Maggi Noodles 4-pack',
    unit: 'pcs',
    cost: 130,
    sale: 150,
    qty: 40,
    reorder: 12,
    supplier: 'distributor',
  },
  {
    name: 'Olpers Milk 1L',
    unit: 'pcs',
    cost: 290,
    sale: 320,
    qty: 18,
    reorder: 6,
    supplier: 'distributor',
    batches: [
      { no: 'M-101', days: 4, qty: 6 },
      { no: 'M-102', days: 25, qty: 12 },
    ],
  },
  {
    name: 'Nestle Dahi 500g',
    unit: 'pcs',
    cost: 140,
    sale: 170,
    qty: 11,
    reorder: 4,
    supplier: 'distributor',
    batches: [
      { no: 'D-07', days: -1, qty: 3 }, // expired yesterday: shown in the expiry list, never sold
      { no: 'D-08', days: 3, qty: 8 },
    ],
  },
  {
    name: 'Colgate Toothpaste 100g',
    unit: 'pcs',
    cost: 210,
    sale: 240,
    qty: 3,
    reorder: 5,
    supplier: 'distributor',
  },
  {
    name: 'Peek Freans Biscuit',
    unit: 'pcs',
    cost: 55,
    sale: 70,
    qty: 48,
    reorder: 12,
    supplier: 'distributor',
    batches: [{ no: 'BF-24', days: 120, qty: 48 }],
  },
];

/** Brands of the packed demo items; a product needs a brand, so loose goods get the neutral "Loose". */
const BRANDS = [
  'Lipton',
  'Tapal',
  'Surf Excel',
  'Lux',
  'Lifebuoy',
  'Rooh Afza',
  'Shan',
  'Maggi',
  'Olpers',
  'Colgate',
  'Peek Freans',
  'Nestle',
];

/** "Olpers Milk 1L" -> { brand: 'Olpers', name: 'Milk 1L' }, so the label reads "Olpers Milk 1L", not "Packed Olpers ...". */
function brandAndName(it: Item): { brand: string; name: string } {
  const brand = BRANDS.find((b) => it.name.startsWith(`${b} `));
  if (brand !== undefined) return { brand, name: it.name.slice(brand.length).trim() };
  return { brand: it.unit === 'pcs' ? 'Packed' : 'Loose', name: it.name };
}

/** kg / litre are stored in grams / millilitres; pieces stay pieces. */
const baseUnits = (qty: number, unit: UnitLabel): number => (unit === 'pcs' ? qty : qty * 1000);

/**
 * Creates a complete demo kiryana shop through the REAL service: loose goods per kg / litre, packed goods by barcode,
 * two wholesaler purchases on credit, khata customers, and six invoices (one weighed, one on khata, one return).
 * Throws ALREADY_SETUP if the shop exists.
 */
export async function seedKiryanaDemo(deps: ServiceDeps): Promise<SeedSummary> {
  const svc = createSeedService(deps);

  await svc.setup.firstRun({
    shopName: 'Bismillah Kiryana Store',
    branchName: 'Main Counter',
    invoicePrefix: 'K',
    owner: { username: 'owner', displayName: 'Owner', pin: '1234' },
    businessType: 'kiryana',
  });
  await deps.driver.batch([upsertMeta(META.demoData, '1')]);

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

  const mandi = await svc.purchasing.createSupplier({
    name: 'Mandi Wholesale Traders',
    phone: '03211234567',
    address: 'Sabzi Mandi',
  });
  const distributor = await svc.purchasing.createSupplier({
    name: 'Lahore Grocery Distributors',
    address: 'Azam Cloth Market',
  });
  const suppliers = { mandi, distributor };

  // catalogue (stock arrives with the two opening purchases below)
  const variantIds = new Map<string, string>();
  for (const [i, it] of ITEMS.entries()) {
    const v = await svc.catalog.createAccessory({
      product: { ...brandAndName(it), category: 'Grocery' },
      sku: `GRO-${String(i + 1).padStart(3, '0')}`,
      // loose goods have no barcode: the cashier weighs them and taps the item
      ...(it.unit === 'pcs' ? { barcode: ean13(`8962000${String(i + 1).padStart(5, '0')}`) } : {}),
      costPrice: rs(it.cost),
      salePrice: rs(it.sale),
      reorderLevel: baseUnits(it.reorder, it.unit),
      unit: it.unit,
    });
    variantIds.set(it.name, v.variant.id);
  }
  const id = (name: string): string => variantIds.get(name) ?? '';

  // opening purchases on credit: 30 % of the loose goods and half of the packed goods paid in cash
  for (const [key, ref, paidShare] of [
    ['mandi', 'OPEN-001', 0.3],
    ['distributor', 'OPEN-002', 0.5],
  ] as const) {
    // one purchase line per delivery: a perishable item has one line per batch
    const accessories = ITEMS.filter((it) => it.supplier === key).flatMap((it) =>
      (it.batches ?? [{ no: null, days: 0, qty: it.qty }]).map((b) => ({
        variantId: id(it.name),
        quantity: baseUnits(b.qty, it.unit),
        unitCost: rs(it.cost),
        scale: unitScaleFor(it.unit),
        ...(b.no === null
          ? {}
          : { batch: { batchNo: b.no, expiryDate: pktDate(Date.now() + b.days * DAY_MS) } }),
      })),
    );
    const total = accessories.reduce((s, l) => s + lineGross(l.quantity, l.unitCost, l.scale), 0);
    await svc.purchasing.receive({
      supplierId: suppliers[key].id,
      referenceNo: ref,
      note: 'Opening stock',
      phones: [],
      accessories: accessories.map(({ scale: _scale, ...line }) => line),
      paidNow: { method: 'cash', amount: Math.floor(total * paidShare) },
    });
  }

  // customers (khata)
  const haji = await svc.khata.createCustomer({
    name: 'Haji Rafiq',
    phone: '03001234567',
    creditLimit: rs(30_000),
    openingBalance: rs(8_500),
  });
  await svc.khata.createCustomer({
    name: 'Bushra Bibi',
    phone: '03211234567',
    openingBalance: rs(2_300),
  });
  await svc.khata.createCustomer({
    name: 'Master Aslam',
    phone: '03331234567',
    creditLimit: rs(20_000),
  });
  await svc.khata.createCustomer({ name: 'Gul Khan', phone: '03451234567' });
  await svc.khata.createCustomer({
    name: 'Nadia Store',
    phone: '03121234567',
    creditLimit: rs(15_000),
  });

  // sample sales, as the cashier
  svc.auth.logout();
  await svc.auth.login('cashier', '3456');
  const sellCash = async (draft: CheckoutDraft) => {
    const p = await svc.checkout.preview(draft);
    return svc.checkout.commit({ ...draft, payments: [{ method: 'cash', amount: p.total }] });
  };

  const sale1 = await sellCash({
    lines: [
      { variantId: id('Chini (sugar)'), quantity: 2_000 },
      { variantId: id('Lipton Yellow Label 190g'), quantity: 2 },
    ],
  });
  // 1.25 kg atta and 500 g salt: the weighed lines
  await sellCash({
    lines: [
      { variantId: id('Atta (flour)'), quantity: 1_250 },
      { variantId: id('Namak (salt)'), quantity: 500 },
    ],
  });
  await sellCash({
    lines: [
      { variantId: id('Cooking Oil (loose)'), quantity: 1_500 },
      { variantId: id('Surf Excel 1kg'), quantity: 1 },
    ],
  });
  await sellCash({
    lines: [
      { variantId: id('Lux Soap 100g'), quantity: 3 },
      { variantId: id('Lifebuoy Soap 100g'), quantity: 2 },
      { variantId: id('Olpers Milk 1L'), quantity: 2 }, // first-expiry-first-out: comes from batch M-101
    ],
  });
  // monthly ration to Haji Rafiq: part cash, Rs 1,500 on khata
  const rationDraft: CheckoutDraft = {
    lines: [
      { variantId: id('Chawal Basmati'), quantity: 5_000 },
      { variantId: id('Chini (sugar)'), quantity: 3_000 },
      { variantId: id('Daal Chana'), quantity: 1_500 },
    ],
    customerId: haji.id,
  };
  const ration = await svc.checkout.preview(rationDraft);
  await svc.checkout.commit({
    ...rationDraft,
    payments: [
      { method: 'cash', amount: ration.total - rs(1_500) },
      { method: 'khata', amount: rs(1_500) },
    ],
  });

  // one packet of tea comes back, as the manager
  svc.auth.logout();
  await svc.auth.login('manager', '2345');
  const teaLine = sale1.lines[1];
  if (teaLine === undefined) throw new Error('seed: sale 1 has no tea line');
  const preview = await svc.checkout.previewReturn(sale1.id, [{ lineId: teaLine.id, quantity: 1 }]);
  await svc.checkout.createReturn({
    originalSaleId: sale1.id,
    lines: [{ lineId: teaLine.id, quantity: 1 }],
    refund: preview.suggestedRefund.map((p) => ({ method: p.method, amount: -p.amount })),
    reason: 'Customer changed mind',
  });
  svc.auth.logout();

  return { phones: 0, accessories: ITEMS.length, customers: 5, suppliers: 2, sales: 6 };
}
