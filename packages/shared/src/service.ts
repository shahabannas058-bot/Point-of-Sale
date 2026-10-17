import type {
  AccessoryVariant,
  ApprovalGrant,
  CatalogHit,
  ChainReport,
  Customer,
  CustomerLedger,
  IntegrityChecks,
  Invoice,
  InvoiceSummary,
  InvoiceView,
  LoginUser,
  PartyBalance,
  PeriodSummary,
  PhoneUnit,
  PhoneUnitView,
  PurchaseResult,
  Session,
  ShopInfo,
  ShopSettings,
  Supplier,
  SupplierLedger,
  SummaryRange,
  User,
  VariantView,
} from './models';
import type { Permission } from './permissions';
import type {
  ApprovalReason,
  EpochMs,
  Id,
  Paisa,
  PaymentMethod,
  PhoneCondition,
  PtaStatus,
  Role,
  SaleKind,
} from './primitives';
// repairs + warranty (Phase 3)
import type {
  ExpiringWarranty,
  RepairStatus,
  RepairTicket,
  RepairTicketView,
  Warranty,
  WarrantyKind,
  WarrantyLookup,
} from './models';

// ---------------- inputs ----------------

export interface FirstRunInput {
  shopName: string;
  branchName: string;
  invoicePrefix: string;
  owner: { username: string; displayName: string; pin: string };
}

export interface NewUserInput {
  username: string;
  displayName: string;
  role: Role;
  pin: string;
}

/** Either an existing product or a new one (matched case-insensitively by brand + name). */
export type ProductRef =
  { productId: Id } | { brand: string; name: string; category?: string | null };

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
  supplierId?: Id | null;
  note?: string | null;
  /** Default true: the unit is added as opening stock. */
  openingStock?: boolean;
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
  openingQty?: number;
}

type Priced<T> = Omit<T, 'costPrice' | 'salePrice'> & { costPrice?: number; salePrice?: number };

export type PhoneUnitPatch = Priced<
  Partial<
    Pick<
      PhoneUnit,
      | 'colour'
      | 'storageGb'
      | 'ramGb'
      | 'batteryHealthPct'
      | 'ptaStatus'
      | 'condition'
      | 'note'
      | 'imei2'
      | 'serial'
    >
  >
>;

export type VariantPatch = Priced<
  Partial<Pick<AccessoryVariant, 'barcode' | 'model' | 'colour' | 'reorderLevel' | 'isActive'>>
>;

export interface NewCustomerInput {
  name: string;
  phone?: string | null;
  cnic?: string | null;
  address?: string | null;
  creditLimit?: number | null;
  openingBalance?: number | null;
}

export type CustomerPatch = Partial<
  Pick<Customer, 'name' | 'phone' | 'cnic' | 'address' | 'notes' | 'isActive'>
> & { creditLimit?: number | null };

export interface NewSupplierInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  /** Supplier ledger: amount the shop already owes this supplier (positive). */
  openingBalance?: number | null;
}

export interface ReceivePurchaseInput {
  supplierId: Id;
  referenceNo?: string | null;
  note?: string | null;
  phones: Omit<NewPhoneUnitInput, 'supplierId' | 'openingStock'>[];
  accessories: { variantId: Id; quantity: number; unitCost: number }[];
  paidNow?: { amount: number; method: Exclude<PaymentMethod, 'khata'> } | null;
}

export interface CartLineInput {
  phoneUnitId?: Id;
  variantId?: Id;
  quantity: number;
  discountAmount?: number;
}

export interface CheckoutDraft {
  lines: CartLineInput[];
  invoiceDiscount?: number;
  customerId?: Id | null;
  note?: string | null;
}

export interface PaymentInput {
  method: PaymentMethod;
  amount: number;
  reference?: string | null;
}

export interface CommitSaleInput extends CheckoutDraft {
  payments: PaymentInput[];
  /** Client-generated UUID v7: re-sending the same id returns the stored invoice (no double sale). */
  saleId?: Id;
  approvalToken?: string;
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
  effectiveDiscountBps: number;
  needsApproval: ApprovalReason[];
  customerBalance: Paisa | null;
  creditLimit: Paisa | null;
}

export interface ReturnLineInput {
  lineId: Id;
  quantity: number;
}

export interface ReturnableLine {
  lineId: Id;
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
  /** Negative (money goes back to the customer). */
  total: Paisa;
  /** Refund split in the same proportion as the original payments (negative amounts are not used: positive). */
  suggestedRefund: PaymentInput[];
}

export interface CreateReturnInput {
  originalSaleId: Id;
  lines: ReturnLineInput[];
  /** Positive amounts; they must add up to |return total|. */
  refund: PaymentInput[];
  reason: string;
  approvalToken?: string;
  saleId?: Id;
}

export interface VoidSaleInput {
  originalSaleId: Id;
  reason: string;
  approvalToken?: string;
  saleId?: Id;
}

export interface InvoiceFilter {
  q?: string;
  fromMs?: EpochMs;
  toMs?: EpochMs;
  kind?: SaleKind;
  customerId?: Id;
  limit?: number;
}

// ---------------- service ----------------

export interface PosService {
  setup: {
    isSetUp(): Promise<boolean>;
    firstRun(input: FirstRunInput): Promise<ShopInfo>;
    getShop(): Promise<ShopInfo>;
  };
  settings: {
    get(): Promise<ShopSettings>;
    update(patch: Partial<ShopSettings>): Promise<ShopSettings>;
  };
  auth: {
    listLoginUsers(): Promise<LoginUser[]>;
    login(username: string, pin: string): Promise<Session>;
    logout(): void;
    current(): Session | null;
    can(permission: Permission): boolean;
    requestApproval(pin: string, reason?: ApprovalReason): Promise<ApprovalGrant>;
    changePin(oldPin: string, newPin: string): Promise<void>;
    listUsers(): Promise<User[]>;
    createUser(input: NewUserInput): Promise<User>;
  };
  catalog: {
    search(query: string, opts?: { limit?: number; inStockOnly?: boolean }): Promise<CatalogHit[]>;
    listPhones(filter?: {
      q?: string;
      inStock?: boolean;
      pta?: PtaStatus;
      condition?: PhoneCondition;
    }): Promise<PhoneUnitView[]>;
    listAccessories(filter?: { q?: string; lowStockOnly?: boolean }): Promise<VariantView[]>;
    createPhoneUnit(input: NewPhoneUnitInput): Promise<PhoneUnitView>;
    createAccessory(input: NewAccessoryInput): Promise<VariantView>;
    updatePhoneUnit(id: Id, patch: PhoneUnitPatch): Promise<PhoneUnitView>;
    updateVariant(id: Id, patch: VariantPatch): Promise<VariantView>;
    adjustStock(input: { variantId: Id; delta: number; reason: string }): Promise<VariantView>;
  };
  purchasing: {
    listSuppliers(): Promise<PartyBalance<Supplier>[]>;
    createSupplier(input: NewSupplierInput): Promise<Supplier>;
    receive(input: ReceivePurchaseInput): Promise<PurchaseResult>;
    paySupplier(input: {
      supplierId: Id;
      amount: number;
      method?: Exclude<PaymentMethod, 'khata'>;
      note?: string | null;
    }): Promise<Paisa>;
    // supplier ledger
    getSupplierLedger(
      supplierId: Id,
      opts?: { limit?: number; beforeCreatedAt?: EpochMs },
    ): Promise<SupplierLedger>;
  };
  checkout: {
    preview(draft: CheckoutDraft): Promise<CartPreview>;
    commit(input: CommitSaleInput): Promise<Invoice>;
    getInvoice(idOrNo: string): Promise<InvoiceView>;
    listInvoices(filter?: InvoiceFilter): Promise<InvoiceSummary[]>;
    previewReturn(originalSaleId: Id, lines: ReturnLineInput[]): Promise<ReturnPreview>;
    createReturn(input: CreateReturnInput): Promise<Invoice>;
    voidSale(input: VoidSaleInput): Promise<Invoice>;
  };
  khata: {
    listCustomers(opts?: {
      q?: string;
      withBalanceOnly?: boolean;
    }): Promise<PartyBalance<Customer>[]>;
    createCustomer(input: NewCustomerInput): Promise<Customer>;
    updateCustomer(id: Id, patch: CustomerPatch): Promise<Customer>;
    getLedger(
      customerId: Id,
      opts?: { limit?: number; beforeCreatedAt?: EpochMs },
    ): Promise<CustomerLedger>;
    receivePayment(input: {
      customerId: Id;
      amount: number;
      method: Exclude<PaymentMethod, 'khata'>;
      note?: string | null;
    }): Promise<Paisa>;
    totals(): Promise<{ receivable: Paisa; customersOwing: number }>;
  };
  reports: {
    summary(range: SummaryRange): Promise<PeriodSummary>;
  };
  integrity: {
    verifyChain(): Promise<ChainReport>;
    checks(): Promise<IntegrityChecks>;
  };
  // Phase 3: repair job tickets and IMEI warranty
  repairs: PosRepairsApi;
  warranty: PosWarrantyApi;
}

// ---------------- repairs + warranty (Phase 3) ----------------

export interface NewRepairTicketInput {
  /** An existing customer, OR a walk-in name (+ phone). */
  customerId?: Id | null;
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
  technicianId?: Id | null;
  promisedAt?: EpochMs | null;
}

export interface RepairTicketPatch {
  problem?: string;
  conditionNotes?: string | null;
  accessories?: string | null;
  estimatedCost?: number;
  finalCharge?: number | null;
  technicianId?: Id | null;
  promisedAt?: EpochMs | null;
}

export interface RepairStatusInput {
  ticketId: Id;
  /** Delivery and cancellation have their own methods (they move money). */
  status: Exclude<RepairStatus, 'delivered' | 'cancelled'>;
  note?: string | null;
}

export interface AddRepairPartInput {
  ticketId: Id;
  variantId: Id;
  quantity: number;
}

export interface DeliverRepairInput {
  ticketId: Id;
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
  ticketId: Id;
  reason: string;
  /** How the advance is given back (default cash). */
  refundMethod?: Exclude<PaymentMethod, 'khata'>;
  /** Needed when money is refunded and the user lacks return_void. */
  approvalToken?: string;
}

export interface RepairFilter {
  q?: string;
  status?: RepairStatus;
  customerId?: Id;
  /** Only tickets that are not delivered / cancelled. */
  openOnly?: boolean;
  limit?: number;
}

export interface RegisterWarrantyInput {
  saleId: Id;
  phoneUnitId: Id;
  kind: WarrantyKind;
  /** Exactly one of `days` (from the sale date) or `endsAt`. */
  days?: number;
  endsAt?: EpochMs;
  note?: string | null;
}

export interface PosRepairsApi {
  create(input: NewRepairTicketInput): Promise<RepairTicketView>;
  get(idOrNo: string): Promise<RepairTicketView>;
  list(filter?: RepairFilter): Promise<RepairTicket[]>;
  update(id: Id, patch: RepairTicketPatch): Promise<RepairTicketView>;
  setStatus(input: RepairStatusInput): Promise<RepairTicketView>;
  addPart(input: AddRepairPartInput): Promise<RepairTicketView>;
  deliver(input: DeliverRepairInput): Promise<RepairTicketView>;
  cancel(input: CancelRepairInput): Promise<RepairTicketView>;
}

export interface PosWarrantyApi {
  register(input: RegisterWarrantyInput): Promise<Warranty>;
  /** NOT_FOUND when no phone unit has this IMEI / serial. */
  lookup(imeiOrSerial: string): Promise<WarrantyLookup>;
  /** Active warranties ending within the next `days` days, soonest first. */
  listExpiring(days: number): Promise<ExpiringWarranty[]>;
}
