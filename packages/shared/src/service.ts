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
}
