import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { uuidv7 } from '@pos/core';
import {
  lineGross,
  type CheckoutDraft,
  type UnitLabel,
  type UnitScale,
  type ItemView,
} from '@pos/shared';

export interface CartLine {
  key: string;
  itemId: string;
  label: string;
  sub: string;
  /** per piece, or per kg / litre for loose goods (integer paisa) */
  unitPrice: number;
  /** 1 for pieces, 1000 for kg / litre. Held bills saved by an older version lack it: read it with lineScale(). */
  unitScale: UnitScale;
  unitLabel: UnitLabel;
  /** in base units: pieces, or grams / millilitres for loose goods */
  qty: number;
  /** on-hand at the time it was added; null when there is no cap */
  maxQty: number | null;
  /** discount on the whole line, integer paisa */
  discount: number;
}

/** Held bills saved before weights existed have no unitScale: they are piece lines. */
export const lineScale = (l: Pick<CartLine, 'unitScale'>): UnitScale =>
  l.unitScale === 1000 ? 1000 : 1;

/** qty x unitPrice / unitScale before any discount, rounded half away from zero (the service's rule). */
export const lineGrossOf = (l: Pick<CartLine, 'qty' | 'unitPrice' | 'unitScale'>): number =>
  lineGross(l.qty, l.unitPrice, lineScale(l));

export interface CartCustomer {
  id: string;
  name: string;
}

export interface HeldBill {
  id: string;
  heldAt: number;
  total: number;
  customer: CartCustomer | null;
  lines: CartLine[];
  invoiceDiscount: number;
  /** the attempt id the bill had when it was held; bills saved by an older version lack it */
  saleId?: string;
  /** the bill's note; bills saved by an older version lack it */
  note?: string;
}

/** 'weighed' = a loose item that is already on the bill: its weight is edited, not added to. */
export type AddResult = 'added' | 'capped' | 'duplicate' | 'out' | 'weighed';

interface CartState {
  lines: CartLine[];
  /**
   * Idempotency key for checkout.commit. One id per cart attempt: it stays while lines are edited,
   * while the pay dialog opens and closes and across failed or timed-out commits (the service
   * replays the same invoice). It rotates when the cart is cleared, held, resumed or emptied.
   */
  saleId: string;
  customer: CartCustomer | null;
  invoiceDiscount: number;
  approvalToken: string | null;
  note: string;
  selected: number;
  held: HeldBill[];
  addItem: (v: ItemView, qty?: number) => AddResult;
  setQty: (key: string, qty: number) => AddResult;
  remove: (key: string) => void;
  setLineDiscount: (key: string, paisa: number) => void;
  setCustomer: (c: CartCustomer | null) => void;
  setInvoiceDiscount: (paisa: number) => void;
  setApproval: (t: string | null) => void;
  setNote: (n: string) => void;
  select: (i: number) => void;
  clear: () => void;
  hold: (total: number) => void;
  resume: (id: string) => void;
  deleteHeld: (id: string) => void;
}

const itemSub = (v: ItemView): string =>
  [v.item.model, v.item.colour, v.item.sku].filter(Boolean).join(' · ');

/** The bill's subtotal: every line's gross less its discount (what the invoice discount may not exceed). */
const subtotalOf = (lines: readonly CartLine[]): number =>
  lines.reduce((sum, l) => sum + lineGrossOf(l) - l.discount, 0);

/** v0 = the mobile-shop build, v1 = `variantId` lines, v2 = `itemId` lines. */
const HELD_BILLS_VERSION = 2;

type Stored = Record<string, unknown>;

const isRecord = (x: unknown): x is Stored =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * One held line from an older version, or null when it cannot be sold any more.
 * v0 and v1 lines name their item `variantId`; v0 phone lines have none (they hold a phoneUnitId) and a `kind` tag.
 */
function migrateLine(line: unknown): CartLine | null {
  if (!isRecord(line)) return null;
  const { kind: _kind, phoneUnitId: _phoneUnitId, variantId, ...rest } = line;
  const itemId = typeof rest.itemId === 'string' ? rest.itemId : variantId;
  if (typeof itemId !== 'string' || itemId === '') return null;
  return { ...rest, itemId } as unknown as CartLine;
}

/**
 * A held bill from an older version. A bill left with no lines is dropped. When some lines were dropped the
 * stored total is wrong, so it becomes 0, and the old attempt id is left out: reusing it could replay the
 * invoice of the full, older bill.
 */
function migrateBill(bill: unknown): HeldBill[] {
  if (!isRecord(bill) || !Array.isArray(bill.lines)) return [];
  const stored: unknown[] = bill.lines;
  const lines = stored.flatMap((l) => {
    const m = migrateLine(l);
    return m ? [m] : [];
  });
  if (lines.length === 0) return [];
  if (lines.length === stored.length) return [{ ...bill, lines } as unknown as HeldBill];
  const { saleId: _saleId, ...rest } = bill;
  return [{ ...rest, lines, total: 0 } as unknown as HeldBill];
}

/** zustand persist `migrate`: maps held bills saved by an older version to the current shape. Never throws. */
export function migrateHeldBills(persisted: unknown, version: number): { held: HeldBill[] } {
  try {
    const stored = isRecord(persisted) ? persisted.held : undefined;
    if (!Array.isArray(stored)) return { held: [] };
    if (version >= HELD_BILLS_VERSION) return { held: stored as HeldBill[] };
    return { held: stored.flatMap(migrateBill) };
  } catch {
    return { held: [] };
  }
}

const empty = {
  lines: [] as CartLine[],
  customer: null,
  invoiceDiscount: 0,
  approvalToken: null,
  note: '',
  selected: -1,
};

/** An empty cart with a fresh attempt id. */
const fresh = (): typeof empty & { saleId: string } => ({ ...empty, saleId: uuidv7() });

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      ...fresh(),
      held: [],
      addItem: (v, qty) => {
        if (v.onHand <= 0) return 'out';
        const scale = v.item.unitScale;
        const { lines } = get();
        const idx = lines.findIndex((l) => l.itemId === v.item.id);
        if (idx >= 0) {
          const cur = lines[idx];
          if (!cur) return 'out';
          if (scale !== 1) {
            // loose goods: scanning again must not silently add another kilo; the cashier edits the weight
            set({ selected: idx });
            return 'weighed';
          }
          const add = qty ?? 1;
          const next = Math.min(cur.qty + add, v.onHand);
          const capped = cur.qty + add > v.onHand;
          set({
            lines: lines.map((l, i) => (i === idx ? { ...l, qty: next, maxQty: v.onHand } : l)),
            selected: idx,
          });
          return capped ? 'capped' : 'added';
        }
        // loose goods start at 1 kg (1000 g); the cashier then types the real weight
        const start = qty ?? (scale === 1 ? 1 : 1000);
        const line: CartLine = {
          key: `v:${v.item.id}`,
          itemId: v.item.id,
          label: v.label,
          sub: itemSub(v),
          unitPrice: v.item.salePrice,
          unitScale: scale,
          unitLabel: v.item.unitLabel,
          qty: Math.min(start, v.onHand),
          maxQty: v.onHand,
          discount: 0,
        };
        set({ lines: [...lines, line], selected: lines.length });
        return start > v.onHand ? 'capped' : 'added';
      },
      setQty: (key, qty) => {
        const line = get().lines.find((l) => l.key === key);
        if (!line) return 'duplicate';
        const max = line.maxQty ?? Number.MAX_SAFE_INTEGER;
        const next = Math.max(1, Math.min(Math.trunc(qty), max));
        // keep the line discount below the new gross so the service never sees discount > gross
        const gross = lineGross(next, line.unitPrice, lineScale(line));
        const lines = get().lines.map((l) =>
          l.key === key ? { ...l, qty: next, discount: Math.min(l.discount, gross) } : l,
        );
        set({
          lines,
          invoiceDiscount: Math.min(get().invoiceDiscount, subtotalOf(lines)),
          approvalToken: null,
        });
        return qty > max ? 'capped' : 'added';
      },
      remove: (key) => {
        const { lines: before, selected } = get();
        const removed = before.findIndex((l) => l.key === key);
        const lines = before.filter((l) => l.key !== key);
        set({
          lines,
          // a line above the selection moved it up one row: follow the same line
          selected: Math.min(
            removed >= 0 && removed < selected ? selected - 1 : selected,
            lines.length - 1,
          ),
          invoiceDiscount: Math.min(get().invoiceDiscount, subtotalOf(lines)),
          approvalToken: null,
          // an emptied cart ends the attempt: whatever is rung up next is a new sale
          ...(lines.length === 0 ? { saleId: uuidv7() } : {}),
        });
      },
      setLineDiscount: (key, paisa) => {
        const lines = get().lines.map((l) =>
          l.key === key ? { ...l, discount: Math.max(0, Math.min(paisa, lineGrossOf(l))) } : l,
        );
        set({
          lines,
          invoiceDiscount: Math.min(get().invoiceDiscount, subtotalOf(lines)),
          approvalToken: null,
        });
      },
      // an approval was given for this bill and customer, not for whoever is picked next
      setCustomer: (customer) => set({ customer, approvalToken: null }),
      setInvoiceDiscount: (invoiceDiscount) =>
        set({ invoiceDiscount: Math.max(0, invoiceDiscount), approvalToken: null }),
      setApproval: (approvalToken) => set({ approvalToken }),
      setNote: (note) => set({ note }),
      select: (selected) => set({ selected }),
      clear: () => set(fresh()),
      hold: (total) => {
        const s = get();
        if (s.lines.length === 0) return;
        const bill: HeldBill = {
          id: `${Date.now()}`,
          heldAt: Date.now(),
          total,
          customer: s.customer,
          lines: s.lines,
          invoiceDiscount: s.invoiceDiscount,
          saleId: s.saleId,
          note: s.note,
        };
        set({ ...fresh(), held: [bill, ...s.held].slice(0, 20) });
      },
      resume: (id) => {
        const s = get();
        const bill = s.held.find((h) => h.id === id);
        if (!bill) return;
        // current cart (if any) is parked so nothing is lost
        const parked: HeldBill[] =
          s.lines.length > 0
            ? [
                {
                  id: `${Date.now()}`,
                  heldAt: Date.now(),
                  total: 0,
                  customer: s.customer,
                  lines: s.lines,
                  invoiceDiscount: s.invoiceDiscount,
                  saleId: s.saleId,
                  note: s.note,
                },
              ]
            : [];
        set({
          lines: bill.lines,
          // the bill keeps the id it was held under, so a commit that timed out before the hold replays
          saleId: bill.saleId ?? uuidv7(),
          customer: bill.customer,
          invoiceDiscount: bill.invoiceDiscount,
          note: bill.note ?? '',
          approvalToken: null,
          selected: bill.lines.length - 1,
          held: [...parked, ...s.held.filter((h) => h.id !== id)],
        });
      },
      deleteHeld: (id) => set({ held: get().held.filter((h) => h.id !== id) }),
    }),
    {
      name: 'pos-held-bills',
      version: HELD_BILLS_VERSION,
      partialize: (s) => ({ held: s.held }),
      migrate: migrateHeldBills,
    },
  ),
);

export function cartToDraft(
  s: Pick<CartState, 'lines' | 'customer' | 'invoiceDiscount' | 'note'>,
): CheckoutDraft {
  return {
    lines: s.lines.map((l) => ({
      itemId: l.itemId,
      quantity: l.qty,
      discountAmount: l.discount,
    })),
    customerId: s.customer?.id ?? null,
    invoiceDiscount: s.invoiceDiscount,
    note: s.note.trim() === '' ? null : s.note.trim(),
  };
}
