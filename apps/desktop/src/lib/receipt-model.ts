import type {
  InvoiceView,
  PaymentMethod,
  PosService,
  SaleKind,
  ShopInfo,
  ShopSettings,
  UnitLabel,
  UnitScale,
} from '@pos/shared';
import { roundOffOf } from '@pos/shared';
import { labelFor } from './qty';

export interface ReceiptItem {
  name: string;
  /** IMEI / serial for phones, null for accessories */
  sub: string | null;
  /** base units: pieces, or grams / millilitres when unitScale is 1000 */
  qty: number;
  unitScale: UnitScale;
  unitLabel: UnitLabel;
  /** per piece, or per kg / litre */
  unitPrice: number;
  /** what the shop took off this line (a weight round-off is not a discount and is not here) */
  discount: number;
  /** qty x rate before `discount`, so Qty x Rate = Price on the slip and the Price column adds up to the subtotal */
  total: number;
}

export interface ReceiptModel {
  shopName: string;
  address: string | null;
  phone: string | null;
  invoiceNo: string;
  kind: SaleKind;
  originalInvoiceNo: string | null;
  createdAt: number;
  cashier: string;
  customer: string | null;
  items: ReceiptItem[];
  /** sum of the item totals, before any discount */
  subtotal: number;
  /** line discounts + invoice discount, always positive; subtotal - discountTotal = total */
  discountTotal: number;
  total: number;
  payments: { method: PaymentMethod; amount: number }[];
  footer: string | null;
  footerUr: string | null;
}

/**
 * Pure: InvoiceView + shop data -> everything a printer needs. No formatting here (the renderer formats),
 * so the same model can later feed an ESC/POS encoder in Rust.
 * `imeis` maps phoneUnitId -> IMEI/serial text (not part of the invoice snapshot).
 */
export function buildReceiptModel(
  view: InvoiceView,
  shop: Pick<ShopInfo, 'branchName'>,
  settings: ShopSettings,
  imeis: Readonly<Record<string, string>> = {},
  /** variantId -> unit label; an invoice line only stores its scale, so loose goods default to kg */
  unitLabels: Readonly<Record<string, UnitLabel>> = {},
): ReceiptModel {
  const inv = view.invoice;
  // a weight round-off is not a discount: the receipt shows the weight, the rate and the rupees the customer paid
  const shownDiscount = (l: (typeof inv.lines)[number]): number =>
    Math.abs(l.discountAmount) - roundOffOf(l.discountAmount, l.unitPrice, l.unitScale);
  const lineDiscounts = inv.lines.reduce((a, l) => a + shownDiscount(l), 0);
  void shop;
  return {
    shopName: settings.shopName,
    address: settings.address,
    phone: settings.phone,
    invoiceNo: inv.invoiceNo,
    kind: inv.kind,
    originalInvoiceNo: view.originalInvoiceNo,
    createdAt: inv.createdAt,
    cashier: view.cashierName,
    customer: view.customerName,
    items: inv.lines.map((l) => ({
      name: l.description,
      sub: l.phoneUnitId ? (imeis[l.phoneUnitId] ?? null) : null,
      qty: Math.abs(l.quantity),
      unitScale: l.unitScale,
      unitLabel: l.variantId === null ? 'pcs' : (unitLabels[l.variantId] ?? labelFor(l.unitScale)),
      unitPrice: l.unitPrice,
      discount: shownDiscount(l),
      total: Math.abs(l.lineTotal) + shownDiscount(l),
    })),
    subtotal: Math.abs(inv.subtotal) + lineDiscounts,
    discountTotal: lineDiscounts + Math.abs(inv.discountTotal),
    total: Math.abs(inv.total),
    payments: inv.payments.map((p) => ({ method: p.method, amount: Math.abs(p.amount) })),
    footer: settings.receiptFooter,
    footerUr: settings.receiptFooterUr,
  };
}

/** Loads everything for one receipt through the service contract. */
export async function loadReceiptModel(service: PosService, idOrNo: string): Promise<ReceiptModel> {
  const [view, shop, settings] = await Promise.all([
    service.checkout.getInvoice(idOrNo),
    service.setup.getShop(),
    service.settings.get(),
  ]);
  const imeis: Record<string, string> = {};
  if (view.invoice.lines.some((l) => l.phoneUnitId)) {
    try {
      for (const p of await service.catalog.listPhones()) {
        const id = p.unit.imei1 ?? p.unit.serial;
        if (id) imeis[p.unit.id] = id;
      }
    } catch {
      /* without view_catalog the receipt simply omits IMEIs */
    }
  }
  const unitLabels: Record<string, UnitLabel> = {};
  if (view.invoice.lines.some((l) => l.unitScale !== 1)) {
    try {
      for (const v of await service.catalog.listAccessories())
        unitLabels[v.variant.id] = v.variant.unitLabel;
    } catch {
      /* without view_catalog the receipt simply says kg */
    }
  }
  return buildReceiptModel(view, shop, settings, imeis, unitLabels);
}
