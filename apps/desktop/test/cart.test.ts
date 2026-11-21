import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitLabel, UnitScale, ItemView } from '@pos/shared';

// the cart persists held bills in localStorage; give the node test environment one
vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
});

import {
  cartToDraft,
  lineGrossOf,
  lineScale,
  migrateHeldBills,
  useCart,
  type CartLine,
} from '../src/store/cart';

const makeItem = (o: {
  id: string;
  onHand: number;
  salePrice: number;
  unitScale?: UnitScale;
  unitLabel?: UnitLabel;
}): ItemView =>
  ({
    item: {
      id: o.id,
      productId: 'p1',
      sku: `SKU-${o.id}`,
      barcode: null,
      model: null,
      colour: null,
      costPrice: 0,
      salePrice: o.salePrice,
      reorderLevel: 0,
      unitScale: o.unitScale ?? 1,
      unitLabel: o.unitLabel ?? 'pcs',
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    product: {
      id: 'p1',
      brand: 'Test',
      name: `Item ${o.id}`,
      category: null,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    onHand: o.onHand,
    lowStock: false,
    label: `Item ${o.id}`,
  }) as unknown as ItemView;

const chini = (onHand = 50_000): ItemView =>
  makeItem({ id: 'chini', onHand, salePrice: 28_550, unitScale: 1000, unitLabel: 'kg' });
const pens = (onHand = 20): ItemView => makeItem({ id: 'pens', onHand, salePrice: 2_500 });

const first = (): CartLine => {
  const l = useCart.getState().lines[0];
  if (l === undefined) throw new Error('cart is empty');
  return l;
};

beforeEach(() => {
  useCart.setState({
    lines: [],
    customer: null,
    invoiceDiscount: 0,
    approvalToken: null,
    note: '',
    selected: -1,
    held: [],
  });
});

describe('cart: pieces keep working as before', () => {
  it('adds a piece item as one piece', () => {
    expect(useCart.getState().addItem(pens())).toBe('added');
    expect(first()).toMatchObject({
      qty: 1,
      unitScale: 1,
      unitLabel: 'pcs',
      unitPrice: 2_500,
      maxQty: 20,
    });
  });

  it('adding it again increments, and stops at stock', () => {
    const cart = useCart.getState();
    cart.addItem(pens(2));
    expect(cart.addItem(pens(2))).toBe('added');
    expect(first().qty).toBe(2);
    expect(useCart.getState().addItem(pens(2))).toBe('capped');
    expect(first().qty).toBe(2);
  });

  it('setQty stays between 1 and stock', () => {
    useCart.getState().addItem(pens());
    const { key } = first();
    useCart.getState().setQty(key, 0);
    expect(first().qty).toBe(1);
    expect(useCart.getState().setQty(key, 99)).toBe('capped');
    expect(first().qty).toBe(20);
  });

  it('a line discount cannot exceed quantity x price', () => {
    useCart.getState().addItem(pens());
    const { key } = first();
    useCart.getState().setQty(key, 3);
    useCart.getState().setLineDiscount(key, 9_000);
    expect(first().discount).toBe(7_500);
  });
});

describe('cart: loose goods sold by weight', () => {
  it('starts a loose item at 1 kg and remembers its unit', () => {
    expect(useCart.getState().addItem(chini())).toBe('added');
    expect(first()).toMatchObject({
      qty: 1000,
      unitScale: 1000,
      unitLabel: 'kg',
      unitPrice: 28_550,
      maxQty: 50_000,
    });
  });

  it('starts at what is left when less than 1 kg is in stock, and says so', () => {
    expect(useCart.getState().addItem(chini(600))).toBe('capped');
    expect(first().qty).toBe(600);
  });

  it('scanning the same loose item again selects the line instead of adding another kilo', () => {
    const cart = useCart.getState();
    cart.addItem(chini());
    useCart.getState().addItem(pens());
    expect(useCart.getState().selected).toBe(1);
    expect(useCart.getState().addItem(chini())).toBe('weighed');
    expect(useCart.getState().lines).toHaveLength(2);
    expect(first().qty).toBe(1000);
    expect(useCart.getState().selected).toBe(0);
  });

  it('setQty takes any number of grams', () => {
    useCart.getState().addItem(chini());
    expect(useCart.getState().setQty(first().key, 1250)).toBe('added');
    expect(first().qty).toBe(1250);
  });

  it('setQty stops at stock and says capped', () => {
    useCart.getState().addItem(chini());
    expect(useCart.getState().setQty(first().key, 60_000)).toBe('capped');
    expect(first().qty).toBe(50_000);
  });

  it('setQty never goes below one gram', () => {
    useCart.getState().addItem(chini());
    useCart.getState().setQty(first().key, 0);
    expect(first().qty).toBe(1);
  });

  it('prices the line with the rounded rule: 1.25 kg x Rs 285.50 = 35,688 paisa', () => {
    useCart.getState().addItem(chini());
    useCart.getState().setQty(first().key, 1250);
    expect(lineGrossOf(first())).toBe(35_688);
  });

  it('a line discount cannot exceed the rounded gross', () => {
    useCart.getState().addItem(chini());
    useCart.getState().setQty(first().key, 1250);
    useCart.getState().setLineDiscount(first().key, 1_000_000);
    expect(first().discount).toBe(35_688);
  });

  it('lowering the weight lowers an existing discount to the new gross', () => {
    useCart.getState().addItem(chini());
    useCart.getState().setQty(first().key, 1250);
    useCart.getState().setLineDiscount(first().key, 30_000);
    useCart.getState().setQty(first().key, 100); // 0.1 kg = 2,855 paisa
    expect(first().discount).toBe(2_855);
  });

  it('the draft sent to the service carries grams', () => {
    useCart.getState().addItem(chini());
    useCart.getState().setQty(first().key, 1250);
    const s = useCart.getState();
    const draft = cartToDraft(s);
    expect(draft.lines).toEqual([{ itemId: 'chini', quantity: 1250, discountAmount: 0 }]);
  });
});

describe('cart: held bills saved before weights existed', () => {
  it('resume as piece lines', () => {
    const old = {
      key: 'v:old',
      itemId: 'old',
      label: 'Old charger',
      sub: '',
      unitPrice: 150_000,
      qty: 2,
      maxQty: 10,
      discount: 0,
    } as unknown as CartLine; // no unitScale / unitLabel: written by an older version
    useCart.setState({
      held: [{ id: 'h1', heldAt: 1, total: 0, customer: null, invoiceDiscount: 0, lines: [old] }],
    });
    useCart.getState().resume('h1');
    const line = first();
    expect(lineScale(line)).toBe(1);
    expect(lineGrossOf(line)).toBe(300_000);
  });
});

describe('cart: held bills saved by older versions (persist migrate)', () => {
  const bill = (id: string, lines: unknown[], extra: Record<string, unknown> = {}) => ({
    id,
    heldAt: 1,
    total: 5_000,
    customer: null,
    invoiceDiscount: 0,
    lines,
    saleId: 'old-sale',
    ...extra,
  });
  const phone = { key: 'p:u1', kind: 'phone', phoneUnitId: 'u1', label: 'Galaxy A55', qty: 1 };
  const v0Item = { key: 'v:pens', kind: 'accessory', variantId: 'pens', label: 'Pen', qty: 2 };
  const v1Item = { key: 'v:pens', variantId: 'pens', label: 'Pen', qty: 2 };
  const v2Item = { key: 'v:pens', itemId: 'pens', label: 'Pen', qty: 2 };

  it('v0 mixed bill: drops the phone line, keeps the item as itemId, zeroes the total and forgets the saleId', () => {
    const { held } = migrateHeldBills({ held: [bill('h1', [phone, v0Item])] }, 0);
    expect(held).toHaveLength(1);
    expect(held[0]?.lines).toEqual([v2Item]);
    expect(held[0]?.total).toBe(0);
    expect(held[0]).not.toHaveProperty('saleId');
  });

  it('v0: drops a bill that held only phones', () => {
    const { held } = migrateHeldBills({ held: [bill('h1', [phone]), bill('h2', [v0Item])] }, 0);
    expect(held.map((h) => h.id)).toEqual(['h2']);
  });

  it('v1 -> v2: renames variantId to itemId and keeps the total and saleId of a whole bill', () => {
    const { held } = migrateHeldBills({ held: [bill('h1', [v1Item])] }, 1);
    expect(held).toEqual([bill('h1', [v2Item])]);
    expect(held[0]?.lines[0]).not.toHaveProperty('variantId');
  });

  it('survives garbage stored state', () => {
    expect(migrateHeldBills(null, 0)).toEqual({ held: [] });
    expect(migrateHeldBills('x', 1)).toEqual({ held: [] });
    expect(migrateHeldBills({ held: 'x' }, 0)).toEqual({ held: [] });
    const { held } = migrateHeldBills(
      {
        held: [
          null,
          7,
          'bill',
          bill('no-lines', 'x' as unknown as unknown[]),
          bill('bad-lines', [null, 3, 'line', { key: 'v:x' }, { variantId: '' }]),
          bill('ok', [v1Item]),
        ],
      },
      1,
    );
    expect(held.map((h) => h.id)).toEqual(['ok']);
  });

  it('leaves current-version state alone', () => {
    const held = [bill('h1', [v2Item])];
    expect(migrateHeldBills({ held }, 2)).toEqual({ held });
  });
});
