import type {
  InvoiceView,
  PaymentMethod,
  PosService,
  SaleKind,
  ShopInfo,
  ShopSettings,
} from '@pos/shared';

export interface ReceiptItem {
  name: string;
  /** IMEI / serial for phones, null for accessories */
  sub: string | null;
  qty: number;
  unitPrice: number;
  discount: number;
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
  subtotal: number;
  /** line discounts + invoice discount, always positive */
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
): ReceiptModel {
  const inv = view.invoice;
  const lineDiscounts = inv.lines.reduce((a, l) => a + Math.abs(l.discountAmount), 0);
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
      unitPrice: l.unitPrice,
      discount: Math.abs(l.discountAmount),
      total: Math.abs(l.lineTotal),
    })),
    subtotal: Math.abs(inv.subtotal),
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
  return buildReceiptModel(view, shop, settings, imeis);
}
