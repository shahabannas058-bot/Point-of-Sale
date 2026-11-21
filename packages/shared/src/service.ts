import type { CashEntry, CashEntryType, DrawerBreakdown, ExpenseCategory } from './cash';
import type { Item, Product } from './catalog';
import type { PaymentMethod, Role, SaleKind } from './enums';
import type { LedgerEntry } from './ledger';
import type { BusinessType, ModuleId } from './modules';
import type { Customer, Supplier, User } from './people';
import type { Paisa } from './primitives';
import type { UnitLabel, UnitScale } from './units';
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
/** details examples: DUPLICATE {field:'sku'}, STOCK_INSUFFICIENT {onHand,requested,lineNo},
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
  | 'cash';
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
/**
 * Newest-first page of a ledger. For the next (older) page pass the last line's entry createdAt as beforeCreatedAt
 * and its id as beforeId: entries that share a timestamp are then neither skipped nor repeated.
 * beforeCreatedAt alone (no beforeId) means "strictly older than this time".
 */
export interface LedgerPageOptions {
  limit?: number;
  beforeCreatedAt?: number;
  beforeId?: string;
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
  /** Picks the starting module set (MODULE_PRESETS). Default 'kiryana'. The licence token overrides it later. */
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
  allowNegativeStock: boolean /* default false */;
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
export interface ItemView {
  item: Item;
  product: Product;
  onHand: number;
  lowStock: boolean /* onHand <= reorderLevel */;
  label: string;
}
export interface CatalogHit {
  kind: 'item';
  matchedBy: 'barcode' | 'sku' | 'name';
  item: ItemView;
}
export interface NewItemInput {
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
export interface ItemRef {
  itemId: string;
}
export type ItemHistoryKind = 'sale' | 'return' | 'purchase' | 'adjustment' | 'transfer';
/** What a stock movement belongs to, resolved for display. */
export type ItemHistoryRef =
  | { kind: 'sale'; saleId: string; invoiceNo: string; customerName: string | null }
  | { kind: 'return'; saleId: string; invoiceNo: string; customerName: string | null }
  | { kind: 'purchase'; purchaseId: string; supplierName: string; referenceNo: string | null }
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

/* ---------- stock adjustment log (every hand-made stock change in the shop, for the owner) ---------- */
export interface StockLogQuery {
  /** Inclusive epoch-ms bounds; default = everything. */
  from?: number;
  to?: number;
  /** Matches the item name, the reason or who did it. */
  q?: string;
  /** Newest-first page size, default 200, max 1000. */
  limit?: number;
  /** Cursor from the previous page (`nextBefore`). */
  before?: { at: number; id: string };
}
export interface StockLogEntry {
  id: string; // stock_movements.id
  at: number;
  item: ItemRef;
  label: string;
  /** 1 for pieces, 1000 for kg / litre: quantities are in base units. */
  unitScale: UnitScale;
  unitLabel: UnitLabel;
  /** Signed, in base units. */
  quantity: number;
  /** The item's on-hand right before and right after this change, base units. */
  balanceBefore: number;
  balanceAfter: number;
  reason: string | null;
  batch: { id: string; batchNo: string | null; expiryDate: string } | null;
  by: { id: string; displayName: string };
}
export interface StockLogPage {
  /** Newest first. */
  entries: StockLogEntry[];
  nextBefore: { at: number; id: string } | null;
  /** Over the whole query (not just this page): how many changes, and how many added or removed stock. */
  summary: { count: number; increases: number; decreases: number };
}

/** The most items Billing can pin as one-tap quick items. */
export const MAX_QUICK_ITEMS = 24;

export interface CatalogApi {
  /**
   * Exact barcode/sku first (scanner: UI auto-adds if exactly 1 exact hit), then LIKE on brand/name/model/colour.
   * Text hits whose name starts with the query come before names that only contain it; `prefixOnly` drops the latter
   * (type-ahead after the first letter: "a" lists the items that start with a, not every SKU with an a inside).
   */
  search(
    query: string,
    opts?: { limit?: number; inStockOnly?: boolean; prefixOnly?: boolean },
  ): Promise<CatalogHit[]>;
  listItems(f?: { q?: string; lowStockOnly?: boolean }): Promise<ItemView[]>;
  /** Every stock movement of one item with running balance, newest first; needs `view_catalog` (unitCost is null without `view_cost`). */
  itemHistory(ref: ItemRef, q?: ItemHistoryQuery): Promise<ItemHistoryPage>;
  createItem(i: NewItemInput): Promise<ItemView>;
  updateItem(
    id: string,
    p: Partial<
      Pick<
        NewItemInput,
        'salePrice' | 'costPrice' | 'barcode' | 'reorderLevel' | 'model' | 'colour'
      >
    >,
  ): Promise<ItemView>;
  adjustStock(i: { itemId: string; delta: number; reason: string }): Promise<ItemView>; // adjust_stock; reason mandatory (DB CHECK)
  /** Billing's pinned one-tap items in pin order; any signed-in user. Items since deactivated or deleted are left out. */
  quickItems(): Promise<ItemView[]>;
  /** Replaces the pinned list (distinct item ids, at most MAX_QUICK_ITEMS); manage_settings. */
  setQuickItems(itemIds: string[]): Promise<ItemView[]>;
}

// ---------- purchasing ----------
export interface ReceivePurchaseInput {
  supplierId: string;
  referenceNo?: string | null;
  note?: string | null;
  items: {
    itemId: string;
    quantity: number;
    unitCost: number;
    /** Module batch_expiry. Creates a batch for this line; the +qty movement belongs to it. */
    batch?: BatchInput | null;
  }[]; // +qty movement; item.cost_price := unitCost (latest cost)
  paidNow?: { method: Exclude<PaymentMethod, 'khata'>; amount: number } | null;
}
/** A delivery's batch (module batch_expiry). `expiryDate` is a Pakistan calendar date, YYYY-MM-DD. */
export interface BatchInput {
  batchNo?: string | null;
  expiryDate: string;
}
export interface PurchaseResult {
  purchase: Purchase;
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
  /** Newest first (created_at, then id); running balance is cumulative per supplier. Needs receive_stock. */
  getLedger(
    supplierId: string,
    o?: LedgerPageOptions,
  ): Promise<{ supplier: Supplier; balance: Paisa; lines: SupplierLedgerLine[] }>;
  /** What the shop owes in total, over suppliers with a positive balance. Needs receive_stock or view_reports. */
  totals(): Promise<{ payable: Paisa; suppliersOwed: number }>;
}

// ---------- checkout / returns ----------
export interface CartLineInput {
  itemId: string;
  quantity: number;
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
    q?: string /* invoiceNo */;
    customerId?: string;
    kind?: SaleKind;
    /** Default 100, max 500. Newest first (created_at, then id). */
    limit?: number;
    /** Cursor for "load more": the last row's createdAt and id; rows after it in the list order come next. */
    beforeCreatedAt?: number;
    beforeId?: string;
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
  /** Newest first (created_at, then id). */
  getLedger(
    customerId: string,
    o?: LedgerPageOptions,
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
  estimatedProfit: Paisa; // netRevenue - estimatedCogs (before expenses)
  expenses: Paisa; // cash book expense entries in range, net of reversals
  netProfit: Paisa; // estimatedProfit - expenses
  lowStock: ItemView[];
}
/** Ascending bucket boundaries: buckets[i]..buckets[i+1] is one chart point (the UI computes local days / months). */
export interface DashboardInput {
  buckets: number[];
}
export interface TrendPoint {
  fromMs: number;
  toMs: number;
  revenue: Paisa; // sum(total) over all kinds: returns and voids net out
  profit: Paisa; // revenue - cost snapshot of the lines, before expenses
  salesCount: number; // kind 'sale' only
}
export interface CategorySales {
  category: string; // '' when the product has none
  revenue: Paisa; // sum(line_total) over all kinds, before invoice discounts
}
export interface DashboardData {
  trend: TrendPoint[];
  /** Stock on hand at cost right now (negative stock counts as zero). */
  inventoryValue: Paisa;
  /** Best five categories by revenue over the whole bucket span, revenue > 0 only. */
  topCategories: CategorySales[];
}
export interface ReportsApi {
  summary(
    r: SummaryRange,
  ): Promise<PeriodSummary> /* view_reports; calls assertCanSell({action:'report'}) */;
  /** Chart data for the dashboard. view_reports; calls assertCanSell({action:'report'}). */
  dashboard(i: DashboardInput): Promise<DashboardData>;
  /** Every stock adjustment in the shop (opening stock, corrections, write-offs), newest first. view_reports; calls assertCanSell({action:'report'}). */
  adjustments(q?: StockLogQuery): Promise<StockLogPage>;
}

// ---------- cash drawer (galla): expenses and day close ----------
export interface CashEntryView extends CashEntry {
  createdByName: string;
  /** A later entry cancels this one. */
  reversed: boolean;
}
/** The open period: everything since the last close (or since the start, before the first close). */
export interface DrawerSnapshot extends DrawerBreakdown {
  periodStart: number; // the last close's closedAt, 0 before the first close
  asOf: number;
  /** Cash book entries of this period, oldest first. */
  entries: CashEntryView[];
  lastClose: DayClose | null;
}
export interface DayClose extends DrawerBreakdown {
  id: string;
  branchId: string;
  periodStart: number;
  closedAt: number;
  counted: Paisa; // cash actually in the drawer
  carriedForward: Paisa; // left in the drawer for the next period (the rest went home / to the bank)
  difference: Paisa; // counted - expected: positive = extra, negative = short
  note: string | null;
  closedBy: string;
  closedByName: string;
}
export interface CashApi {
  /** Expected cash right now and how it adds up. Needs sell. */
  drawer(): Promise<DrawerSnapshot>;
  /** Records an expense (category required) or other cash in / out. Needs sell. */
  addEntry(i: {
    type: CashEntryType;
    category?: ExpenseCategory | null;
    amount: number /* positive paisa */;
    note?: string | null;
  }): Promise<CashEntry>;
  /** Cancels an entry of the open period with its negative twin. Needs return_void. */
  reverseEntry(i: { entryId: string; reason?: string | null }): Promise<CashEntry>;
  /** Counts the drawer and starts a new period. 0 <= carriedForward <= counted. Needs sell. */
  closeDay(i: { counted: number; carriedForward: number; note?: string | null }): Promise<DayClose>;
  /** Past closes, newest first (default 30). Needs view_reports. */
  listCloses(o?: { limit?: number }): Promise<DayClose[]>;
}

// ---------- batches and expiry (module batch_expiry) ----------
export interface BatchView {
  id: string;
  itemId: string;
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
  list(f?: { withinDays?: number; itemId?: string }): Promise<BatchView[]>;
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
    unsentOutbox: number;
  }>; // v_sale_* views
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
  readonly cash: CashApi;
  readonly batches: BatchesApi;
  readonly integrity: IntegrityApi;
  readonly insights: InsightsApi;
}

// ---------- till insights + reorder suggestions ----------
export interface ItemInsightInput {
  itemId: string;
  /** The bill's customer, for "last rate to this customer" and the khata balance. */
  customerId?: string | null;
}
export interface ItemInsight {
  /** Stock that can be sold, in base units: on hand minus what sits in expired batches. */
  onHand: number;
  /** Stock in expired batches (module batch_expiry), in base units; 0 for items without batches. */
  expiredOnHand: number;
  /** Latest purchase / opening cost per priced unit. Null without view_cost or when never bought. */
  lastPurchase: { unitCost: Paisa; at: number } | null;
  /** Latest sale of this item to customerId, per priced unit after line discount. */
  lastSoldToCustomer: { unitPrice: Paisa; at: number; invoiceNo: string } | null;
  /** Khata balance of customerId (positive = customer owes); null for walk-in. */
  customerBalance: Paisa | null;
  /** Net base units sold (sales minus returns) in the last 30 days. */
  soldLast30Days: number;
}
export interface ReorderOptions {
  /** Sales window used for the daily average (default 30, 1-365). */
  days?: number;
  /** Days of sales the order should cover on top of the reorder level (default 14, 1-180). */
  coverDays?: number;
}
export interface ReorderSuggestion {
  item: ItemView;
  /** Net base units sold in the window. */
  sold: number;
  /** sold / days, rounded to 2 decimals. */
  dailyAvg: number;
  /** Whole days until stock runs out at the current rate; null when nothing sold. */
  daysLeft: number | null;
  /** max(0, reorderLevel + ceil(sold * coverDays / days) - onHand), in base units. */
  suggestedQty: number;
  /** Cost per priced unit used for the estimate (latest purchase, else the item cost). Null without view_cost. */
  unitCost: Paisa | null;
}
export interface InsightsApi {
  /** Till info panel for one cart item. Needs sell. */
  item(input: ItemInsightInput): Promise<ItemInsight>;
  /** Active items at or below their reorder level, or that run out within 7 days, most urgent first. Needs view_catalog. */
  reorder(options?: ReorderOptions): Promise<ReorderSuggestion[]>;
}
