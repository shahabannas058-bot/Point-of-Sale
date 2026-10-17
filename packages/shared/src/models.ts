import type {
  EpochMs,
  Id,
  LedgerEntryType,
  Paisa,
  PaymentMethod,
  PhoneCondition,
  ProductKind,
  PtaStatus,
  Role,
  SaleKind,
} from './primitives';

// ---------------- shop / users ----------------

export interface ShopInfo {
  deviceId: Id;
  branchId: Id;
  branchName: string;
  invoicePrefix: string;
  createdAt: EpochMs;
  /** True when the database holds demo data (shows the reset button). */
  isDemo: boolean;
}

export interface ShopSettings {
  shopName: string;
  address: string | null;
  phone: string | null;
  receiptFooter: string | null;
  receiptFooterUr: string | null;
  /** Largest discount (basis points of gross) a cashier may give without a manager PIN. */
  cashierMaxDiscountBps: number;
  allowNegativeStock: boolean;
}

export interface User {
  id: Id;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface LoginUser {
  username: string;
  displayName: string;
  role: Role;
}

export interface Session {
  user: User;
  startedAt: EpochMs;
}

export interface ApprovalGrant {
  token: string;
  approverUsername: string;
  expiresAt: EpochMs;
}

// ---------------- catalog ----------------

export interface Product {
  id: Id;
  kind: ProductKind;
  brand: string;
  name: string;
  category: string | null;
  isActive: boolean;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface PhoneUnit {
  id: Id;
  productId: Id;
  imei1: string | null;
  imei2: string | null;
  serial: string | null;
  colour: string | null;
  storageGb: number | null;
  ramGb: number | null;
  batteryHealthPct: number | null;
  ptaStatus: PtaStatus;
  condition: PhoneCondition;
  costPrice: Paisa;
  salePrice: Paisa;
  supplierId: Id | null;
  note: string | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface AccessoryVariant {
  id: Id;
  productId: Id;
  sku: string;
  barcode: string | null;
  model: string | null;
  colour: string | null;
  costPrice: Paisa;
  salePrice: Paisa;
  reorderLevel: number;
  isActive: boolean;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface PhoneUnitView {
  unit: PhoneUnit;
  product: Product;
  inStock: boolean;
  label: string;
}

export interface VariantView {
  variant: AccessoryVariant;
  product: Product;
  onHand: number;
  lowStock: boolean;
  label: string;
}

export type CatalogHit =
  | { kind: 'phone_unit'; matchedBy: 'imei' | 'serial' | 'name'; item: PhoneUnitView }
  | { kind: 'variant'; matchedBy: 'barcode' | 'sku' | 'name'; item: VariantView };

// ---------------- parties / ledger ----------------

export interface Customer {
  id: Id;
  name: string;
  phone: string | null;
  cnic: string | null;
  address: string | null;
  creditLimit: Paisa | null;
  notes: string | null;
  isActive: boolean;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface Supplier {
  id: Id;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface PartyBalance<T> {
  party: T;
  /** Positive = they owe the shop (customer) / the shop owes them (supplier). */
  balance: Paisa;
  lastActivityAt: EpochMs | null;
}

export interface LedgerEntry {
  id: Id;
  customerId: Id | null;
  supplierId: Id | null;
  type: LedgerEntryType;
  amount: Paisa;
  method: Exclude<PaymentMethod, 'khata'> | null;
  saleId: Id | null;
  purchaseId: Id | null;
  note: string | null;
  createdBy: Id;
  createdAt: EpochMs;
}

export interface LedgerLine {
  entry: LedgerEntry;
  runningBalance: Paisa;
  invoiceNo: string | null;
}

export interface CustomerLedger {
  customer: Customer;
  balance: Paisa;
  /** Newest first. */
  lines: LedgerLine[];
}

// ---------------- invoices ----------------

export interface SaleLine {
  id: Id;
  saleId: Id;
  lineNo: number;
  productId: Id;
  phoneUnitId: Id | null;
  variantId: Id | null;
  description: string;
  /** Negative on return / void lines. */
  quantity: number;
  unitPrice: Paisa;
  costPrice: Paisa;
  discountAmount: Paisa;
  lineTotal: Paisa;
  createdAt: EpochMs;
}

export interface SalePayment {
  id: Id;
  saleId: Id;
  method: PaymentMethod;
  amount: Paisa;
  reference: string | null;
  createdAt: EpochMs;
}

export interface Invoice {
  id: Id;
  deviceId: Id;
  seq: number;
  invoiceNo: string;
  kind: SaleKind;
  originalSaleId: Id | null;
  branchId: Id;
  customerId: Id | null;
  cashierId: Id;
  subtotal: Paisa;
  discountTotal: Paisa;
  total: Paisa;
  note: string | null;
  createdAt: EpochMs;
  hashVersion: number;
  prevHash: string;
  hash: string;
  lines: SaleLine[];
  payments: SalePayment[];
}

export interface InvoiceView {
  invoice: Invoice;
  customerName: string | null;
  cashierName: string;
  originalInvoiceNo: string | null;
}

export interface InvoiceSummary {
  id: Id;
  invoiceNo: string;
  kind: SaleKind;
  createdAt: EpochMs;
  customerName: string | null;
  cashierName: string;
  total: Paisa;
  /** Sum of |total| of the returns / voids made against this sale. */
  returnedTotal: Paisa;
}

// ---------------- purchasing ----------------

export interface Purchase {
  id: Id;
  supplierId: Id;
  branchId: Id;
  kind: 'purchase' | 'return';
  referenceNo: string | null;
  total: Paisa;
  note: string | null;
  createdBy: Id;
  createdAt: EpochMs;
}

export interface PurchaseResult {
  purchase: Purchase;
  phoneUnitIds: Id[];
  supplierBalance: Paisa;
}

// ---------------- reports / integrity ----------------

export interface SummaryRange {
  fromMs: EpochMs;
  toMs: EpochMs;
}

export interface PeriodSummary {
  range: SummaryRange;
  salesCount: number;
  returnsCount: number;
  grossSales: Paisa;
  discounts: Paisa;
  netSales: Paisa;
  returnsTotal: Paisa;
  netRevenue: Paisa;
  byMethod: Record<PaymentMethod, Paisa>;
  khataCollected: Paisa;
  cashInDrawer: Paisa;
  estimatedCogs: Paisa;
  estimatedProfit: Paisa;
  lowStock: VariantView[];
}

export type ChainReport =
  | { ok: true; count: number; headSeq: number; headHash: string }
  | { ok: false; reason: string; seq: number | null; invoiceNo: string | null };

export interface IntegrityChecks {
  salePaymentMismatch: number;
  saleLineMismatch: number;
  badPhoneUnits: number;
  unsentOutbox: number;
}
