import type { AccessoryVariant, PhoneUnit, Product } from './catalog';
import type { PaymentMethod, PhoneCondition, PtaStatus, Role, SaleKind } from './enums';
import type { LedgerEntry } from './ledger';
import type { BusinessType, ModuleId } from './modules';
import type { Customer, Supplier, User } from './people';
import type { Paisa } from './primitives';
import type { UnitLabel, UnitScale } from './units';
import type {
  RepairStatus,
  RepairTicket,
  RepairTicketView,
  Warranty,
  WarrantyKind,
  WarrantySaleInfo,
  WarrantyStatus,
} from './repairs';
import type { Invoice } from './sales';
import type { Purchase } from './stock';

// ---------- errors ----------
export const SERVICE_ERROR_CODES = [
  'NOT_SETUP',
  'ALREADY_SETUP',
  'NOT_AUTHENTICATED',
  'INVALID_CREDENTIALS',
  'LOGIN_LOCKED',
  'FORBIDDEN',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'LICENCE_BLOCKED',
  'MODULE_DISABLED',
  'VALIDATION',
  'NOT_FOUND',
  'DUPLICATE',
  'EMPTY_CART',
  'STOCK_INSUFFICIENT',
  'UNIT_NOT_IN_STOCK',
  'PAYMENT_MISMATCH',
  'KHATA_NEEDS_CUSTOMER',
  'DISCOUNT_INVALID',
  'MONEY_INVALID',
  'ALREADY_RETURNED',
  'RETURN_NOT_ALLOWED',
  'CHAIN_CONFLICT',
  'SALE_ID_REUSED',
  'IMMUTABLE_RECORD',
  'LEDGER_CORRUPT',
  'DB_CONSTRAINT',
  'INTERNAL',
] as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];
/** details examples: DUPLICATE {field:'imei1'}, STOCK_INSUFFICIENT {onHand,requested,lineNo},
 *  APPROVAL_REQUIRED {reason: ApprovalReason}, LOGIN_LOCKED {retryAfterMs}, LICENCE_BLOCKED {state}. UI maps code -> i18n key `err.<CODE>`. */
export class ServiceError extends Error {
  override name = 'ServiceError';
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}
export const isServiceError = (e: unknown): e is ServiceError => e instanceof ServiceError;

// ---------- permissions ----------
export const PERMISSIONS = [
  'sell',
  'receive_khata',
  'view_catalog',
  'edit_catalog',
  'receive_stock',
  'adjust_stock',
  'return_void',
  'discount_unlimited',
  'view_reports',
  'view_cost',
  'manage_settings',
  'manage_users',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
const MANAGER = [
  'sell',
  'receive_khata',
  'view_catalog',
  'edit_catalog',
  'receive_stock',
  'adjust_stock',
  'return_void',
  'discount_unlimited',
  'view_reports',
  'view_cost',
] as const satisfies readonly Permission[];
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  cashier: ['sell', 'receive_khata', 'view_catalog'],
  manager: MANAGER,
  owner: PERMISSIONS,
};
export const hasPermission = (role: Role, p: Permission): boolean =>
  ROLE_PERMISSIONS[role].includes(p);

// ---------- licence hook (the ONLY place licensing plugs in) ----------
export type GuardAction =
  | 'sale'
  | 'return'
  | 'void'
  | 'purchase'
  | 'stock_entry'
  | 'report'
  | 'ledger_entry'
  | 'catalog_edit'
  | 'repair'
  | 'warranty';
export interface SellGuardContext {
  action: GuardAction;
  branchId: string;
  now: number;
}
/** Must throw ServiceError('LICENCE_BLOCKED', ..., {state}) to block. Called inside the write lock, right before db.batch. */
export type AssertCanSell = (ctx: SellGuardContext) => Promise<void>;

// ---------- common ----------
export interface PaymentInput {
  method: PaymentMethod;
  amount: number /* positive integer paisa */;
  reference?: string | null;
}
export type ApprovalReason = 'discount' | 'credit_limit' | 'return' | 'void';
export interface ApprovalGrant {
  token: string;
  approverUsername: string;
  expiresAt: number;
} // single use, 60 s, in memory
export interface Session {
  user: User;
  startedAt: number;
}
export interface PartyBalance<T> {
  party: T;
  balance: Paisa;
  lastActivityAt: number | null;
} // customer: +owes us; supplier: +we owe

// ---------- setup / settings ----------
export interface SetupInput {
  shopName: string;
  branchName: string;
  invoicePrefix: string /* ^[A-Z0-9]{1,4}$ */;
  owner: { username: string; displayName: string; pin: string /* exactly 4 digits */ };
  /** Picks the starting module set (MODULE_PRESETS). Default 'custom' = every module. The licence token overrides it later. */
  businessType?: BusinessType;
}
export interface ShopInfo {
  deviceId: string;
  branchId: string;
  branchName: string;
  /** The shop's display name (settings.shopName); readable before login for the sign-in screen. */
  shopName: string;
  invoicePrefix: string;
  createdAt: number;
  isDemo: boolean;
  businessType: BusinessType;
  /** Optional feature packs this shop owns (`core` is always on). A call to another module fails with MODULE_DISABLED. */
  modules: ModuleId[];
}
export interface ShopSettings {
  shopName: string;
  address: string | null;
  phone: string | null;
  receiptFooter: string | null;
  receiptFooterUr: string | null;
  cashierMaxDiscountBps: number /* default 500 = 5% of gross; above it a cashier needs approval */;
  allowNegativeStock: boolean /* accessories only; default false. Phone units are always guarded by the DB trigger */;
}
export interface SetupApi {
  isSetUp(): Promise<boolean>;
  firstRun(input: SetupInput): Promise<ShopInfo>; // ALREADY_SETUP if run twice; writes app_meta + branch + owner (+outbox)
  getShop(): Promise<ShopInfo>; // NOT_SETUP before firstRun
}
export interface SettingsApi {
  get(): Promise<ShopSettings>;
  update(patch: Partial<ShopSettings>): Promise<ShopSettings> /* manage_settings */;
}

// ---------- auth ----------
export interface AuthApi {
  listLoginUsers(): Promise<Pick<User, 'username' | 'displayName' | 'role'>[]>;
  login(username: string, pin: string): Promise<Session>; // INVALID_CREDENTIALS (same for unknown user), LOGIN_LOCKED after 5 fails/30 s
  logout(): void;
  current(): Session | null;
  can(p: Permission): boolean;
  /** Manager/owner PIN -> single-use grant. Cashier passes grant.token as approvalToken on commit/return/void. */
  requestApproval(pin: string): Promise<ApprovalGrant>; // APPROVAL_INVALID on wrong PIN
  changePin(oldPin: string, newPin: string): Promise<void>;
  listUsers(): Promise<User[]>; // manage_users
  createUser(i: { username: string; displayName: string; role: Role; pin: string }): Promise<User>;
}

// ---------- catalog ----------
export type ProductRef =
  { productId: string } | { brand: string; name: string; category?: string | null }; // find-or-create by brand+name
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
  lowStock: boolean /* onHand <= reorderLevel */;
  label: string;
}
export type CatalogHit =
  | { kind: 'phone_unit'; matchedBy: 'imei' | 'serial' | 'name'; item: PhoneUnitView }
  | { kind: 'variant'; matchedBy: 'barcode' | 'sku' | 'name'; item: VariantView };
export interface NewPhoneUnitInput {
  product: ProductRef;
  imei1?: string | null;
  imei2?: string | null;
  serial?: string | null;
  colour?: string | null;
  storageGb?: number | null;
  ramGb?: number | null;
  batteryHealthPct?: number | null;
  ptaStatus: PtaStatus;
  condition: PhoneCondition;
  costPrice: number;
  salePrice: number;
  supplierId?: string | null;
  note?: string | null;
}
export interface NewAccessoryInput {
  product: ProductRef;
  sku: string;
  barcode?: string | null;
  model?: string | null;
  colour?: string | null;
  /** Per priced unit: per piece, or per kg / litre when `unit` is 'kg' / 'L'. */
  costPrice: number;
  salePrice: number;
  /** In base units (pieces, or grams / millilitres for 'kg' / 'L'). */
  reorderLevel?: number;
  /** In base units. Becomes an adjustment movement 'Opening stock'. */
  openingQty?: number;
  /** Default 'pcs'. 'kg' and 'L' need the `weight_units` module; they cannot be changed once stock exists. */
  unit?: UnitLabel;
}

/* ---------- item history (one item's full stock story, like Abuzar's Ctrl+H) ---------- */
export type ItemRef = { variantId: string } | { phoneUnitId: string };
export type ItemHistoryKind = 'sale' | 'return' | 'purchase' | 'adjustment' | 'repair' | 'transfer';
/** What a stock movement belongs to, resolved for display. */
export type ItemHistoryRef =
  | { kind: 'sale'; saleId: string; invoiceNo: string; customerName: string | null }
  | { kind: 'return'; saleId: string; invoiceNo: string; customerName: string | null }
  | { kind: 'purchase'; purchaseId: string; supplierName: string; referenceNo: string | null }
  | { kind: 'repair'; ticketId: string; ticketNo: string }
  | { kind: 'adjustment' }
  | { kind: 'transfer'; transferId: string };
export interface ItemHistoryEntry {
  id: string; // stock_movements.id
  at: number; // created_at (epoch ms)
  kind: ItemHistoryKind;
  /** Signed, in base units (pieces, or grams / ml). */
  quantity: number;
  /** On-hand in base units right after this entry (oldest -> newest running sum). */
  balanceAfter: number;
  /** Per priced unit, when the movement recorded one (purchases, sales at cost). */
  unitCost: Paisa | null;
  ref: ItemHistoryRef;
  reason: string | null;
  batch: { id: string; batchNo: string | null; expiryDate: string } | null;
  by: { id: string; displayName: string };
}
export interface ItemHistoryQuery {
  /** Inclusive epoch-ms bounds; default = everything. */
  from?: number;
  to?: number;
  /** Newest-first page size, default 200, max 1000. */
  limit?: number;
  /** Cursor from the previous page (`nextBefore`). */
  before?: { at: number; id: string };
}
export interface ItemHistoryPage {
  /** Newest first. */
  entries: ItemHistoryEntry[];
  /** Cursor for the next (older) page, null when done. */
  nextBefore: { at: number; id: string } | null;
  /** Totals over the whole query range (not just this page), base units. */
  summary: { purchased: number; sold: number; returned: number; adjusted: number; onHand: number };
}

export interface CatalogApi {
  /** Exact barcode/sku/imei/serial first (scanner: UI auto-adds if exactly 1 exact hit), then LIKE on brand/name/model/colour. */
  search(query: string, opts?: { limit?: number; inStockOnly?: boolean }): Promise<CatalogHit[]>;
  listPhones(f?: {
    q?: string;
    inStock?: boolean;
    pta?: PtaStatus;
    condition?: PhoneCondition;
  }): Promise<PhoneUnitView[]>;
  listAccessories(f?: { q?: string; lowStockOnly?: boolean }): Promise<VariantView[]>;
  /** Every stock movement of one item with running balance, newest first; needs `view_catalog` (unitCost is null without `view_cost`). */
  itemHistory(ref: ItemRef, q?: ItemHistoryQuery): Promise<ItemHistoryPage>;
  createPhoneUnit(
    i: NewPhoneUnitInput & { openingStock?: boolean /* default true: +1 adjustment */ },
  ): Promise<PhoneUnitView>; // DUPLICATE {field}
  createAccessory(i: NewAccessoryInput): Promise<VariantView>;
  updatePhoneUnit(
    id: string,
    p: Partial<
      Pick<
        NewPhoneUnitInput,
        | 'salePrice'
        | 'costPrice'
        | 'colour'
        | 'note'
        | 'ptaStatus'
        | 'condition'
        | 'batteryHealthPct'
      >
    >,
  ): Promise<PhoneUnitView>;
  updateVariant(
    id: string,
    p: Partial<
      Pick<
        NewAccessoryInput,
        'salePrice' | 'costPrice' | 'barcode' | 'reorderLevel' | 'model' | 'colour'
      >
    >,
  ): Promise<VariantView>;
  adjustStock(i: { variantId: string; delta: number; reason: string }): Promise<VariantView>; // adjust_stock; reason mandatory (DB CHECK)
}

// ---------- purchasing ----------
export interface ReceivePurchaseInput {
  supplierId: string;
  referenceNo?: string | null;
  note?: string | null;
  phones: NewPhoneUnitInput[]; // each creates unit + 'purchase' +1 movement (unit_cost = costPrice)
  accessories: {
    variantId: string;
    quantity: number;
    unitCost: number;
    /** Module batch_expiry. Creates a batch for this line; the +qty movement belongs to it. */
    batch?: BatchInput | null;
  }[]; // +qty movement; variant.cost_price := unitCost (latest cost)
  paidNow?: { method: Exclude<PaymentMethod, 'khata'>; amount: number } | null;
}
/** A delivery's batch (module batch_expiry). `expiryDate` is a Pakistan calendar date, YYYY-MM-DD. */
export interface BatchInput {
  batchNo?: string | null;
  expiryDate: string;
}
export interface PurchaseResult {
  purchase: Purchase;
  phoneUnitIds: string[];
  supplierBalance: Paisa;
}
export interface SupplierLedgerLine {
  entry: LedgerEntry;
  runningBalance: Paisa; // positive = the shop owes the supplier
  referenceNo: string | null; // the supplier's own invoice number on the linked purchase
}
export interface PurchasingApi {
  listSuppliers(): Promise<PartyBalance<Supplier>[]>;
  createSupplier(i: {
    name: string;
    phone?: string | null;
    address?: string | null;
  }): Promise<Supplier>;
  receive(i: ReceivePurchaseInput): Promise<PurchaseResult>; // purchases + movements + ledger purchase_credit(+total) [+ payment_made(-paid)]
  paySupplier(i: {
    supplierId: string;
    amount: number;
    method: Exclude<PaymentMethod, 'khata'>;
    note?: string;
  }): Promise<Paisa>; // returns new balance
  /** Newest first; running balance is cumulative per supplier. Needs receive_stock. */
  getLedger(
    supplierId: string,
    o?: { limit?: number; beforeCreatedAt?: number },
  ): Promise<{ supplier: Supplier; balance: Paisa; lines: SupplierLedgerLine[] }>;
  /** What the shop owes in total, over suppliers with a positive balance. Needs receive_stock or view_reports. */
  totals(): Promise<{ payable: Paisa; suppliersOwed: number }>;
}

// ---------- checkout / returns ----------
export interface CartLineInput {
  phoneUnitId?: string;
  variantId?: string;
  quantity: number /* phone = 1 */;
  discountAmount?: number /* paisa, >=0 */;
}
export interface CheckoutDraft {
  lines: CartLineInput[];
  customerId?: string | null;
  invoiceDiscount?: number;
  note?: string | null;
}
export interface PreviewLine {
  lineNo: number;
  description: string;
  /** Base units (pieces, or grams / millilitres when unitScale is 1000). */
  quantity: number;
  unitScale: UnitScale;
  /** Per priced unit (per piece, or per kg / litre). */
  unitPrice: Paisa;
  discountAmount: Paisa;
  lineTotal: Paisa;
  onHand: number;
}
export interface CartPreview {
  lines: PreviewLine[];
  grossTotal: Paisa;
  lineDiscounts: Paisa;
  subtotal: Paisa;
  invoiceDiscount: Paisa;
  total: Paisa;
  effectiveDiscountBps: number; // (lineDiscounts+invoiceDiscount) * 10000 / gross, floor
  needsApproval: ApprovalReason[]; // empty when session role has discount_unlimited
  customerBalance: Paisa | null;
  creditLimit: Paisa | null;
}
export interface CommitSaleInput extends CheckoutDraft {
  payments: PaymentInput[]; // must sum EXACTLY to preview.total (core assertPaymentsMatchTotal)
  saleId?: string; // UI-generated UUID v7 = idempotency key: re-commit returns the stored invoice
  approvalToken?: string;
}
export interface InvoiceView {
  invoice: Invoice;
  customerName: string | null;
  cashierName: string;
  originalInvoiceNo: string | null;
}
export interface InvoiceSummary {
  id: string;
  invoiceNo: string;
  kind: SaleKind;
  createdAt: number;
  customerName: string | null;
  cashierName: string;
  total: Paisa;
  returnedTotal: Paisa;
}
export interface ReturnableLine {
  lineId: string;
  lineNo: number;
  description: string;
  /** Base units, like Invoice lines. */
  soldQty: number;
  returnedQty: number;
  remainingQty: number;
  unitScale: UnitScale;
  unitPrice: Paisa;
}
export interface ReturnPreview {
  original: InvoiceView;
  lines: ReturnableLine[];
  total: Paisa /* negative */;
  suggestedRefund: PaymentInput[] /* negative amounts, split by core allocate() over original payments */;
}
export interface CreateReturnInput {
  originalSaleId: string;
  lines: { lineId: string; quantity: number /* positive units to return */ }[];
  refund: PaymentInput[]; // POSITIVE amounts here; service negates. 'khata' = credit customer's khata (return_credit)
  reason: string;
  saleId?: string;
  approvalToken?: string;
}
export interface CheckoutApi {
  preview(d: CheckoutDraft): Promise<CartPreview>; // read-only, same validation as commit (no payments)
  commit(i: CommitSaleInput): Promise<Invoice>; // atomic: sales+lines+movements+payments+ledger+outbox, hash-chained
  getInvoice(idOrInvoiceNo: string): Promise<InvoiceView>;
  listInvoices(f?: {
    fromMs?: number;
    toMs?: number;
    q?: string /* invoiceNo or IMEI */;
    customerId?: string;
    kind?: SaleKind;
    limit?: number;
  }): Promise<InvoiceSummary[]>;
  previewReturn(
    originalSaleId: string,
    lines: { lineId: string; quantity: number }[],
  ): Promise<ReturnPreview>;
  createReturn(i: CreateReturnInput): Promise<Invoice>; // kind 'return'; stock +, ledger/payments negative; return_void permission or approval
  voidSale(i: {
    originalSaleId: string;
    reason: string;
    saleId?: string;
    approvalToken?: string;
  }): Promise<Invoice>; // kind 'void' = return of all remaining lines, refund mirrors original payments
}

// ---------- khata ----------
export interface LedgerLine {
  entry: LedgerEntry;
  runningBalance: Paisa;
  invoiceNo: string | null;
}
export interface KhataApi {
  listCustomers(o?: { q?: string; withBalanceOnly?: boolean }): Promise<PartyBalance<Customer>[]>;
  createCustomer(i: {
    name: string;
    phone?: string | null;
    cnic?: string | null;
    address?: string | null;
    creditLimit?: number | null;
    openingBalance?: number;
  }): Promise<Customer>; // openingBalance>0 => opening_balance entry
  updateCustomer(
    id: string,
    p: Partial<Pick<Customer, 'name' | 'phone' | 'address' | 'creditLimit' | 'notes'>>,
  ): Promise<Customer>;
  getLedger(
    customerId: string,
    o?: { limit?: number; beforeCreatedAt?: number },
  ): Promise<{ customer: Customer; balance: Paisa; lines: LedgerLine[] }>;
  receivePayment(i: {
    customerId: string;
    amount: number;
    method: Exclude<PaymentMethod, 'khata'>;
    note?: string;
  }): Promise<Paisa>; // payment_received(-amount); VALIDATION if amount > balance
  totals(): Promise<{ receivable: Paisa; customersOwing: number }>;
  /** One customer's udhaar statement for a period: opening balance, every entry in [from, to) ascending with running balance, closing balance. Any session. */
  statement(customerId: string, range: SummaryRange): Promise<CustomerStatement>;
  /** Every active customer who owes money, biggest balance first, with the dates of their last udhaar and last payment. Any session. */
  pendingUdhaar(): Promise<PendingUdhaar[]>;
}
export interface CustomerStatement {
  customer: Customer;
  range: SummaryRange;
  opening: Paisa; // balance before range.fromMs (positive = customer owed the shop)
  udhaarGiven: Paisa; // sum of positive entries in range (sale_credit, opening_balance, +adjustment)
  paid: Paisa; // magnitude of negative entries in range (payment_received, return_credit, -adjustment)
  closing: Paisa; // opening + udhaarGiven - paid = balance at range.toMs
  lines: LedgerLine[]; // ascending by created_at, runningBalance starts from `opening`
}
export interface PendingUdhaar {
  party: Customer;
  balance: Paisa; // > 0
  lastCreditAt: number | null; // last entry that increased the balance
  lastPaymentAt: number | null; // last payment_received
}

// ---------- reports ----------
export interface SummaryRange {
  fromMs: number;
  toMs: number;
} // [from, to), UI computes local day bounds (PKT has no DST)
export interface PeriodSummary {
  range: SummaryRange;
  salesCount: number;
  returnsCount: number /* kind return|void */;
  grossSales: Paisa; // sum(qty*unit_price) over kind='sale'
  discounts: Paisa; // line discounts + invoice discount_total over kind='sale'
  netSales: Paisa; // sum(total) kind='sale'
  returnsTotal: Paisa; // magnitude (positive) of return|void totals
  netRevenue: Paisa; // netSales - returnsTotal
  byMethod: Record<PaymentMethod, Paisa>; // signed payments in range (refunds net out); khata = credit given net
  khataCollected: Paisa; // payment_received ledger entries in range (magnitude)
  cashInDrawer: Paisa; // byMethod.cash + cash khata receipts
  estimatedCogs: Paisa; // sum(qty*cost_price snapshot) signed over all kinds
  estimatedProfit: Paisa; // netRevenue - estimatedCogs (no expenses yet)
  lowStock: VariantView[];
}
export interface ReportsApi {
  summary(
    r: SummaryRange,
  ): Promise<PeriodSummary> /* view_reports; calls assertCanSell({action:'report'}) */;
}

// ---------- batches and expiry (module batch_expiry) ----------
export interface BatchView {
  id: string;
  variantId: string;
  /** The item's display name, e.g. "Olpers Milk 1L". */
  label: string;
  batchNo: string | null;
  /** Pakistan calendar date, YYYY-MM-DD. */
  expiryDate: string;
  /** Base units still in this batch (pieces, or grams / millilitres when unitScale is 1000). */
  onHand: number;
  unitScale: UnitScale;
  unitLabel: UnitLabel;
  /** Whole days from today to the expiry date; negative = already expired, 0 = expires today. */
  daysLeft: number;
  createdAt: number;
}
export interface BatchesApi {
  /** Batches that still have stock, earliest expiry first. Needs a session. */
  list(f?: { withinDays?: number; variantId?: string }): Promise<BatchView[]>;
  /** Moves a batch's whole stock out as an 'adjustment' with the reason. Needs adjust_stock. */
  writeOff(i: { batchId: string; reason: string }): Promise<void>;
}

// ---------- integrity ----------
export type ChainReport =
  | { ok: true; count: number; headSeq: number; headHash: string }
  | { ok: false; reason: string; seq: number | null; invoiceNo: string | null };
export interface IntegrityApi {
  verifyChain(): Promise<ChainReport>; // pages of 500 invoices via verifyChain(startSeq, startPrevHash) from @pos/core
  checks(): Promise<{
    salePaymentMismatch: number;
    saleLineMismatch: number;
    badPhoneUnits: number;
    unsentOutbox: number;
  }>; // v_sale_* views, units outside 0..1
}

// ---------- repair job tickets ----------
export interface NewRepairTicketInput {
  /** An existing customer, OR a walk-in name (+ phone). */
  customerId?: string | null;
  walkIn?: { name: string; phone?: string | null } | null;
  deviceBrand: string;
  deviceModel: string;
  /** Luhn-checked when given. */
  imei?: string | null;
  serial?: string | null;
  problem: string;
  conditionNotes?: string | null;
  accessories?: string | null;
  estimatedCost: number;
  advance?: {
    amount: number;
    method: Exclude<PaymentMethod, 'khata'>;
    reference?: string | null;
  } | null;
  technicianId?: string | null;
  promisedAt?: number | null;
}
export interface RepairTicketPatch {
  problem?: string;
  conditionNotes?: string | null;
  accessories?: string | null;
  estimatedCost?: number;
  finalCharge?: number | null;
  technicianId?: string | null;
  promisedAt?: number | null;
}
export interface RepairStatusInput {
  ticketId: string;
  /** Delivery and cancellation have their own methods (they move money). */
  status: Exclude<RepairStatus, 'delivered' | 'cancelled'>;
  note?: string | null;
}
export interface AddRepairPartInput {
  ticketId: string;
  variantId: string;
  quantity: number;
}
export interface DeliverRepairInput {
  ticketId: string;
  /** Defaults to the ticket's finalCharge, else its estimate. */
  finalCharge?: number;
  /**
   * Positive amounts that add up to |finalCharge - paid so far|: collected when positive, refunded when the
   * advance was larger (refunds cannot be khata). Empty when nothing is due.
   */
  payments: PaymentInput[];
  note?: string | null;
  /** Needed when finalCharge is below the estimate by more than cashierMaxDiscountBps (no discount_unlimited). */
  approvalToken?: string;
}
export interface CancelRepairInput {
  ticketId: string;
  reason: string;
  /** How the advance is given back (default cash). */
  refundMethod?: Exclude<PaymentMethod, 'khata'>;
  /** Needed when money is refunded and the user lacks return_void. */
  approvalToken?: string;
}
export interface RepairFilter {
  q?: string;
  status?: RepairStatus;
  customerId?: string;
  /** Only tickets that are not delivered / cancelled. */
  openOnly?: boolean;
  limit?: number;
}
/** Spare parts are consumed from accessory stock as 'adjustment' movements (see migration 0005). */
export interface RepairsApi {
  create(input: NewRepairTicketInput): Promise<RepairTicketView>;
  get(idOrNo: string): Promise<RepairTicketView>;
  list(filter?: RepairFilter): Promise<RepairTicket[]>;
  update(id: string, patch: RepairTicketPatch): Promise<RepairTicketView>;
  setStatus(input: RepairStatusInput): Promise<RepairTicketView>;
  addPart(input: AddRepairPartInput): Promise<RepairTicketView>;
  deliver(input: DeliverRepairInput): Promise<RepairTicketView>;
  cancel(input: CancelRepairInput): Promise<RepairTicketView>;
}

// ---------- warranty by IMEI ----------
export interface RegisterWarrantyInput {
  saleId: string;
  phoneUnitId: string;
  kind: WarrantyKind;
  /** Exactly one of `days` (from the sale date) or `endsAt`. */
  days?: number;
  endsAt?: number;
  note?: string | null;
}
export interface WarrantyLookup {
  unit: PhoneUnitView;
  /** The latest sale of this unit, or null if it was never sold. */
  sale: WarrantySaleInfo | null;
  /** Warranties registered on that sale. */
  warranties: WarrantyStatus[];
}
export interface ExpiringWarranty {
  status: WarrantyStatus;
  unitLabel: string;
  imei: string | null;
  serial: string | null;
  invoiceNo: string;
  customerName: string | null;
  customerPhone: string | null;
}
export interface WarrantyApi {
  register(input: RegisterWarrantyInput): Promise<Warranty>;
  /** NOT_FOUND when no phone unit has this IMEI / serial. */
  lookup(imeiOrSerial: string): Promise<WarrantyLookup>;
  /** Active warranties ending within the next `days` days, soonest first. */
  listExpiring(days: number): Promise<ExpiringWarranty[]>;
}

export interface PosService {
  readonly setup: SetupApi;
  readonly settings: SettingsApi;
  readonly auth: AuthApi;
  readonly catalog: CatalogApi;
  readonly purchasing: PurchasingApi;
  readonly checkout: CheckoutApi;
  readonly khata: KhataApi;
  readonly reports: ReportsApi;
  readonly batches: BatchesApi;
  readonly integrity: IntegrityApi;
  readonly repairs: RepairsApi;
  readonly warranty: WarrantyApi;
}
