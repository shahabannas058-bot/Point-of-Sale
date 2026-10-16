import type { AccessoryVariant, PhoneUnit, Product } from './catalog';
import type { PaymentMethod, PhoneCondition, PtaStatus, Role, SaleKind } from './enums';
import type { LedgerEntry } from './ledger';
import type { Customer, Supplier, User } from './people';
import type { Paisa } from './primitives';
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
  | 'catalog_edit';
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
  owner: { username: string; displayName: string; pin: string /* 4-6 digits */ };
}
export interface ShopInfo {
  deviceId: string;
  branchId: string;
  branchName: string;
  invoicePrefix: string;
  createdAt: number;
  isDemo: boolean;
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
  costPrice: number;
  salePrice: number;
  reorderLevel?: number;
  openingQty?: number /* adjustment movement 'Opening stock' */;
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
  accessories: { variantId: string; quantity: number; unitCost: number }[]; // +qty movement; variant.cost_price := unitCost (latest cost)
  paidNow?: { method: Exclude<PaymentMethod, 'khata'>; amount: number } | null;
}
export interface PurchaseResult {
  purchase: Purchase;
  phoneUnitIds: string[];
  supplierBalance: Paisa;
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
  quantity: number;
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
  soldQty: number;
  returnedQty: number;
  remainingQty: number;
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

export interface PosService {
  readonly setup: SetupApi;
  readonly settings: SettingsApi;
  readonly auth: AuthApi;
  readonly catalog: CatalogApi;
  readonly purchasing: PurchasingApi;
  readonly checkout: CheckoutApi;
  readonly khata: KhataApi;
  readonly reports: ReportsApi;
  readonly integrity: IntegrityApi;
}
