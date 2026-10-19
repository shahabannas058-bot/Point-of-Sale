import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VariantView } from '@pos/shared';

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

import { useCart } from '../src/store/cart';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const variant = (id: string): VariantView =>
  ({
    variant: {
      id,
      productId: 'p1',
      sku: `SKU-${id}`,
      barcode: null,
      model: null,
      colour: null,
      costPrice: 0,
      salePrice: 10_000,
      reorderLevel: 0,
      unitScale: 1,
      unitLabel: 'pcs',
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    product: {
      id: 'p1',
      kind: 'accessory',
      brand: 'Test',
      name: `Item ${id}`,
      category: null,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    onHand: 50,
    lowStock: false,
    label: `Item ${id}`,
  }) as unknown as VariantView;

const cart = () => useCart.getState();

beforeEach(() => {
  cart().clear();
  for (const h of cart().held) cart().deleteHeld(h.id);
});

describe('cart saleId lifecycle', () => {
  it('always holds a UUID v7 sale id, even for an empty cart', () => {
    expect(cart().saleId).toMatch(UUID_V7);
  });

  it('keeps the same id while lines are added and edited (one attempt = one id)', () => {
    const id = cart().saleId;
    cart().addVariant(variant('a'));
    cart().addVariant(variant('b'));
    cart().setQty('v:a', 3);
    cart().setLineDiscount('v:a', 100);
    cart().setInvoiceDiscount(50);
    cart().setNote('x');
    cart().setApproval('tok');
    cart().setApproval(null);
    cart().remove('v:b');
    expect(cart().saleId).toBe(id);
  });

  it('rotates the id when the cart is cleared (successful commit / explicit clear)', () => {
    cart().addVariant(variant('a'));
    const id = cart().saleId;
    cart().clear();
    expect(cart().saleId).not.toBe(id);
    expect(cart().saleId).toMatch(UUID_V7);
  });

  it('rotates the id when the last line is removed, so a refilled cart is a new attempt', () => {
    cart().addVariant(variant('a'));
    const id = cart().saleId;
    cart().remove('v:a');
    expect(cart().lines).toHaveLength(0);
    expect(cart().saleId).not.toBe(id);
  });

  it('gives the live cart a fresh id on hold and keeps the held bill its own id', () => {
    cart().addVariant(variant('a'));
    const id = cart().saleId;
    cart().hold(10_000);
    const live = cart().saleId;
    expect(live).not.toBe(id);
    expect(cart().held[0]?.saleId).toBe(id);
    expect(cart().held[0]?.saleId).not.toBe(live);
  });

  it('restores the held bill id on resume and parks the live cart under its own id', () => {
    cart().addVariant(variant('a'));
    const heldId = cart().saleId;
    cart().hold(10_000);
    const parkedBill = cart().held[0];
    expect(parkedBill).toBeDefined();

    cart().addVariant(variant('b'));
    const liveId = cart().saleId;
    cart().resume(parkedBill!.id);

    expect(cart().saleId).toBe(heldId);
    expect(cart().lines.map((l) => l.key)).toEqual(['v:a']);
    const parked = cart().held.find((h) => h.lines[0]?.key === 'v:b');
    expect(parked?.saleId).toBe(liveId);
    expect(new Set([cart().saleId, ...cart().held.map((h) => h.saleId)]).size).toBe(
      cart().held.length + 1,
    );
  });

  it('mints an id for held bills saved by an older version without one', () => {
    cart().addVariant(variant('a'));
    cart().hold(10_000);
    const old = cart().held[0]!;
    useCart.setState({ held: [{ ...old, saleId: undefined }] });
    cart().resume(old.id);
    expect(cart().saleId).toMatch(UUID_V7);
    expect(cart().saleId).not.toBe(old.saleId);
  });

  it('does not change the id when resuming an unknown bill', () => {
    const id = cart().saleId;
    cart().resume('nope');
    expect(cart().saleId).toBe(id);
  });
});
