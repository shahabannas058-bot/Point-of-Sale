import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CheckoutDraft, PhoneUnitView, VariantView } from '@pos/shared';

export interface CartLine {
  key: string;
  kind: 'phone' | 'accessory';
  phoneUnitId?: string;
  variantId?: string;
  label: string;
  sub: string;
  unitPrice: number;
  qty: number;
  /** accessory on-hand at the time it was added; null for phones (qty fixed at 1) */
  maxQty: number | null;
  /** discount on the whole line, integer paisa */
  discount: number;
}

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
}

export type AddResult = 'added' | 'capped' | 'duplicate' | 'out';

interface CartState {
  lines: CartLine[];
  customer: CartCustomer | null;
  invoiceDiscount: number;
  approvalToken: string | null;
  note: string;
  selected: number;
  held: HeldBill[];
  addPhone: (v: PhoneUnitView) => AddResult;
  addVariant: (v: VariantView, qty?: number) => AddResult;
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

const phoneLabel = (v: PhoneUnitView): string => v.label;
const phoneSub = (v: PhoneUnitView): string =>
  [v.unit.imei1 ?? v.unit.serial, v.unit.colour].filter(Boolean).join(' · ');
const variantSub = (v: VariantView): string =>
  [v.variant.model, v.variant.colour, v.variant.sku].filter(Boolean).join(' · ');

const empty = {
  lines: [] as CartLine[],
  customer: null,
  invoiceDiscount: 0,
  approvalToken: null,
  note: '',
  selected: -1,
};

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      ...empty,
      held: [],
      addPhone: (v) => {
        if (!v.inStock) return 'out';
        const { lines } = get();
        if (lines.some((l) => l.phoneUnitId === v.unit.id)) return 'duplicate';
        const line: CartLine = {
          key: `p:${v.unit.id}`,
          kind: 'phone',
          phoneUnitId: v.unit.id,
          label: phoneLabel(v),
          sub: phoneSub(v),
          unitPrice: v.unit.salePrice,
          qty: 1,
          maxQty: null,
          discount: 0,
        };
        set({ lines: [...lines, line], selected: lines.length, approvalToken: null });
        return 'added';
      },
      addVariant: (v, qty = 1) => {
        if (v.onHand <= 0) return 'out';
        const { lines } = get();
        const idx = lines.findIndex((l) => l.variantId === v.variant.id);
        if (idx >= 0) {
          const cur = lines[idx];
          if (!cur) return 'out';
          const next = Math.min(cur.qty + qty, v.onHand);
          const capped = cur.qty + qty > v.onHand;
          set({
            lines: lines.map((l, i) => (i === idx ? { ...l, qty: next, maxQty: v.onHand } : l)),
            selected: idx,
          });
          return capped ? 'capped' : 'added';
        }
        const line: CartLine = {
          key: `v:${v.variant.id}`,
          kind: 'accessory',
          variantId: v.variant.id,
          label: v.label,
          sub: variantSub(v),
          unitPrice: v.variant.salePrice,
          qty: Math.min(qty, v.onHand),
          maxQty: v.onHand,
          discount: 0,
        };
        set({ lines: [...lines, line], selected: lines.length });
        return qty > v.onHand ? 'capped' : 'added';
      },
      setQty: (key, qty) => {
        const line = get().lines.find((l) => l.key === key);
        if (!line || line.kind === 'phone') return 'duplicate';
        const max = line.maxQty ?? Number.MAX_SAFE_INTEGER;
        const next = Math.max(1, Math.min(Math.trunc(qty), max));
        // keep the line discount below the new gross so the service never sees discount > gross
        const gross = next * line.unitPrice;
        set({
          lines: get().lines.map((l) =>
            l.key === key ? { ...l, qty: next, discount: Math.min(l.discount, gross) } : l,
          ),
          approvalToken: null,
        });
        return qty > max ? 'capped' : 'added';
      },
      remove: (key) => {
        const lines = get().lines.filter((l) => l.key !== key);
        set({ lines, selected: Math.min(get().selected, lines.length - 1), approvalToken: null });
      },
      setLineDiscount: (key, paisa) =>
        set({
          lines: get().lines.map((l) =>
            l.key === key
              ? { ...l, discount: Math.max(0, Math.min(paisa, l.unitPrice * l.qty)) }
              : l,
          ),
          approvalToken: null,
        }),
      setCustomer: (customer) => set({ customer }),
      setInvoiceDiscount: (invoiceDiscount) =>
        set({ invoiceDiscount: Math.max(0, invoiceDiscount), approvalToken: null }),
      setApproval: (approvalToken) => set({ approvalToken }),
      setNote: (note) => set({ note }),
      select: (selected) => set({ selected }),
      clear: () => set({ ...empty }),
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
        };
        set({ ...empty, held: [bill, ...s.held].slice(0, 20) });
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
                },
              ]
            : [];
        set({
          lines: bill.lines,
          customer: bill.customer,
          invoiceDiscount: bill.invoiceDiscount,
          approvalToken: null,
          selected: bill.lines.length - 1,
          held: [...parked, ...s.held.filter((h) => h.id !== id)],
        });
      },
      deleteHeld: (id) => set({ held: get().held.filter((h) => h.id !== id) }),
    }),
    { name: 'pos-held-bills', partialize: (s) => ({ held: s.held }) },
  ),
);

export function cartToDraft(
  s: Pick<CartState, 'lines' | 'customer' | 'invoiceDiscount' | 'note'>,
): CheckoutDraft {
  return {
    lines: s.lines.map((l) => ({
      ...(l.phoneUnitId ? { phoneUnitId: l.phoneUnitId } : {}),
      ...(l.variantId ? { variantId: l.variantId } : {}),
      quantity: l.qty,
      discountAmount: l.discount,
    })),
    customerId: s.customer?.id ?? null,
    invoiceDiscount: s.invoiceDiscount,
    note: s.note.trim() === '' ? null : s.note.trim(),
  };
}
