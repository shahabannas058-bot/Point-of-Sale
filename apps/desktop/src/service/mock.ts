/* In-memory PosService used by `?mock=1` and as a standalone UI harness.
   It honours the same contract (errors, permissions, approvals, immutability) as the real service,
   but keeps everything in plain arrays. Nothing here touches SQLite. */
import {
  GENESIS_HASH,
  allocate,
  assertPaymentsMatchTotal,
  createUuidV7Generator,
  formatInvoiceNo,
  lineTotal,
  paisa,
  saleTotals,
  sealInvoice,
  verifyChain,
} from '@pos/core';
import {
  ServiceError,
  hasPermission,
  type AccessoryVariant,
  type ApprovalGrant,
  type ApprovalReason,
  type CartPreview,
  type CatalogHit,
  type CheckoutDraft,
  type CommitSaleInput,
  type Customer,
  type Invoice,
  type InvoiceSummary,
  type InvoiceView,
  type LedgerEntry,
  type LedgerEntryType,
  type LedgerLine,
  type NewAccessoryInput,
  type NewPhoneUnitInput,
  type Paisa,
  type PartyBalance,
  type PaymentInput,
  type PaymentMethod,
  type PeriodSummary,
  type Permission,
  type PhoneUnit,
  type PhoneUnitView,
  type PosService,
  type PreviewLine,
  type Product,
  type ProductRef,
  type PurchaseResult,
  type ReceivePurchaseInput,
  type ReturnPreview,
  type ReturnableLine,
  type Role,
  type SaleLine,
  type ServiceErrorCode,
  type Session,
  type ShopInfo,
  type ShopSettings,
  type Supplier,
  type User,
  type VariantView,
  PAYMENT_METHODS,
} from '@pos/shared';

const cast = <T>(v: unknown): T => v as T;
const fail = (
  code: ServiceErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never => {
  throw new ServiceError(code, message, details);
};
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

interface MockUser extends User {
  pin: string;
}

function build(): { service: PosService; seed: () => Promise<void> } {
  const gen = createUuidV7Generator();
  const newId = (): string => gen();
  const now = (): number => Date.now();

  // ---------------- state ----------------
  let shop: ShopInfo | null = null;
  let settings: ShopSettings = {
    shopName: 'My Mobile Shop',
    address: null,
    phone: null,
    receiptFooter: null,
    receiptFooterUr: null,
    cashierMaxDiscountBps: 500,
    allowNegativeStock: false,
  };
  const users: MockUser[] = [];
  const products: Product[] = [];
  const units: PhoneUnit[] = [];
  const unitInStock = new Map<string, boolean>();
  const variants: AccessoryVariant[] = [];
  const variantQty = new Map<string, number>();
  const customers: Customer[] = [];
  const suppliers: Supplier[] = [];
  const ledger: LedgerEntry[] = [];
  const supplierLedger: { supplierId: string; amount: number; at: number }[] = [];
  const invoices: Invoice[] = [];
  const idempotent = new Map<string, Invoice>();
  const grants = new Map<string, { expiresAt: number; username: string }>();
  const fails = new Map<string, { n: number; until: number }>();
  let session: Session | null = null;
  let prevHash: string = GENESIS_HASH;

  // ---------------- helpers ----------------
  const role = (): Role | null => session?.user.role ?? null;
  const can = (p: Permission): boolean => {
    const r = role();
    return r !== null && hasPermission(r, p);
  };
  const require = (p: Permission): void => {
    if (!session) fail('NOT_AUTHENTICATED', 'Sign in first');
    if (!can(p)) fail('FORBIDDEN', `Missing permission ${p}`);
  };
  const needSession = (): Session => session ?? fail('NOT_AUTHENTICATED', 'Sign in first');
  const publicUser = (u: MockUser): User => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  });
  const productOf = (id: string): Product =>
    products.find((p) => p.id === id) ?? fail('NOT_FOUND', 'Product not found');

  const unitLabel = (u: PhoneUnit): string => {
    const p = productOf(u.productId);
    const mem =
      u.ramGb && u.storageGb
        ? ` ${u.ramGb}/${u.storageGb}`
        : u.storageGb
          ? ` ${u.storageGb}GB`
          : '';
    return `${p.brand} ${p.name}${mem}`;
  };
  const unitView = (u: PhoneUnit): PhoneUnitView => ({
    unit: u,
    product: productOf(u.productId),
    inStock: unitInStock.get(u.id) === true,
    label: unitLabel(u),
  });
  const variantView = (v: AccessoryVariant): VariantView => {
    const onHand = variantQty.get(v.id) ?? 0;
    const p = productOf(v.productId);
    return {
      variant: v,
      product: p,
      onHand,
      lowStock: onHand <= v.reorderLevel,
      label: [p.name, v.model, v.colour].filter(Boolean).join(' · '),
    };
  };
  const customerBalance = (id: string): number =>
    sum(ledger.filter((e) => e.customerId === id).map((e) => e.amount));
  const supplierBalance = (id: string): number =>
    sum(supplierLedger.filter((e) => e.supplierId === id).map((e) => e.amount));

  const findOrCreateProduct = (ref: ProductRef, kind: 'phone' | 'accessory'): Product => {
    if ('productId' in ref) return productOf(ref.productId);
    const hit = products.find(
      (p) =>
        p.kind === kind &&
        p.brand.toLowerCase() === ref.brand.toLowerCase() &&
        p.name.toLowerCase() === ref.name.toLowerCase(),
    );
    if (hit) return hit;
    const t = now();
    const p: Product = cast({
      id: newId(),
      kind,
      brand: ref.brand,
      name: ref.name,
      category: ref.category ?? null,
      isActive: true,
      createdAt: t,
      updatedAt: t,
    });
    products.push(p);
    return p;
  };

  const luhn = (s: string): boolean => {
    let total = 0;
    for (let i = 0; i < s.length; i++) {
      let d = Number(s[s.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      total += d;
    }
    return total % 10 === 0;
  };

  const addPhone = (i: NewPhoneUnitInput, inStock: boolean): PhoneUnit => {
    const imei1 = i.imei1 ?? null;
    if (imei1 === null && !i.serial) fail('VALIDATION', 'Provide IMEI or serial');
    for (const field of ['imei1', 'imei2'] as const) {
      const v = i[field];
      if (v && (!/^\d{15}$/.test(v) || !luhn(v)))
        fail('VALIDATION', `${field} is not a valid IMEI`, { field });
    }
    for (const field of ['imei1', 'imei2', 'serial'] as const) {
      const v = i[field];
      if (v && units.some((u) => u.imei1 === v || u.imei2 === v || u.serial === v))
        fail('DUPLICATE', `${field} already exists`, { field });
    }
    const p = findOrCreateProduct(i.product, 'phone');
    const t = now();
    const u: PhoneUnit = cast({
      id: newId(),
      productId: p.id,
      imei1,
      imei2: i.imei2 ?? null,
      serial: i.serial ?? null,
      colour: i.colour ?? null,
      storageGb: i.storageGb ?? null,
      ramGb: i.ramGb ?? null,
      batteryHealthPct: i.batteryHealthPct ?? null,
      ptaStatus: i.ptaStatus,
      condition: i.condition,
      costPrice: i.costPrice,
      salePrice: i.salePrice,
      supplierId: i.supplierId ?? null,
      note: i.note ?? null,
      createdAt: t,
      updatedAt: t,
    });
    units.push(u);
    unitInStock.set(u.id, inStock);
    return u;
  };

  const addVariantRow = (i: NewAccessoryInput): AccessoryVariant => {
    if (variants.some((v) => v.sku === i.sku))
      fail('DUPLICATE', 'SKU already exists', { field: 'sku' });
    if (i.barcode && variants.some((v) => v.barcode === i.barcode))
      fail('DUPLICATE', 'Barcode already exists', { field: 'barcode' });
    const p = findOrCreateProduct(i.product, 'accessory');
    const t = now();
    const v: AccessoryVariant = cast({
      id: newId(),
      productId: p.id,
      sku: i.sku,
      barcode: i.barcode ?? null,
      model: i.model ?? null,
      colour: i.colour ?? null,
      costPrice: i.costPrice,
      salePrice: i.salePrice,
      reorderLevel: i.reorderLevel ?? 5,
      isActive: true,
      createdAt: t,
      updatedAt: t,
    });
    variants.push(v);
    variantQty.set(v.id, i.openingQty ?? 0);
    return v;
  };

  const addLedger = (e: {
    customerId: string;
    type: LedgerEntryType;
    amount: number;
    method?: Exclude<PaymentMethod, 'khata'> | null;
    saleId?: string | null;
    note?: string | null;
    at?: number;
  }): void => {
    ledger.push(
      cast<LedgerEntry>({
        id: newId(),
        customerId: e.customerId,
        supplierId: null,
        type: e.type,
        amount: e.amount,
        method: e.method ?? null,
        saleId: e.saleId ?? null,
        purchaseId: null,
        note: e.note ?? null,
        createdBy: needSessionOrSystem(),
        createdAt: e.at ?? now(),
      }),
    );
  };
  const needSessionOrSystem = (): string => session?.user.id ?? users[0]?.id ?? newId();

  const consumeApproval = (token: string | undefined, reason: ApprovalReason): void => {
    if (!token) fail('APPROVAL_REQUIRED', 'Manager approval required', { reason });
    const g = grants.get(token as string);
    if (!g || g.expiresAt < now()) fail('APPROVAL_INVALID', 'Approval expired or invalid');
    grants.delete(token as string);
  };

  // ---------------- checkout ----------------
  const grossOf = (draft: CheckoutDraft): { gross: number; lineDisc: number } => {
    let gross = 0;
    let lineDisc = 0;
    for (const l of draft.lines) {
      const price = l.phoneUnitId
        ? (units.find((u) => u.id === l.phoneUnitId)?.salePrice ?? 0)
        : (variants.find((v) => v.id === l.variantId)?.salePrice ?? 0);
      gross += price * l.quantity;
      lineDisc += l.discountAmount ?? 0;
    }
    return { gross, lineDisc };
  };

  const buildPreview = (draft: CheckoutDraft): CartPreview => {
    if (draft.lines.length === 0) fail('EMPTY_CART', 'Cart is empty');
    const lines: PreviewLine[] = draft.lines.map((l, idx) => {
      const lineNo = idx + 1;
      const disc = l.discountAmount ?? 0;
      if (l.phoneUnitId) {
        const u =
          units.find((x) => x.id === l.phoneUnitId) ?? fail('NOT_FOUND', 'Phone unit not found');
        if (unitInStock.get(u.id) !== true)
          fail('UNIT_NOT_IN_STOCK', 'Unit already sold', { lineNo });
        const total = lineTotal({
          quantity: 1,
          unitPrice: paisa(u.salePrice),
          discountAmount: paisa(disc),
        });
        return {
          lineNo,
          description: unitLabel(u),
          quantity: 1,
          unitPrice: paisa(u.salePrice),
          discountAmount: paisa(disc),
          lineTotal: total,
          onHand: 1,
        };
      }
      const v =
        variants.find((x) => x.id === l.variantId) ?? fail('NOT_FOUND', 'Accessory not found');
      const onHand = variantQty.get(v.id) ?? 0;
      if (l.quantity > onHand && !settings.allowNegativeStock)
        fail('STOCK_INSUFFICIENT', 'Not enough stock', { onHand, requested: l.quantity, lineNo });
      const total = lineTotal({
        quantity: l.quantity,
        unitPrice: paisa(v.salePrice),
        discountAmount: paisa(disc),
      });
      return {
        lineNo,
        description: variantView(v).label,
        quantity: l.quantity,
        unitPrice: paisa(v.salePrice),
        discountAmount: paisa(disc),
        lineTotal: total,
        onHand,
      };
    });
    const invDisc = draft.invoiceDiscount ?? 0;
    const t = saleTotals(
      lines.map((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountAmount: l.discountAmount,
      })),
      paisa(invDisc),
    );
    const { gross, lineDisc } = grossOf(draft);
    const bps = gross > 0 ? Math.floor(((lineDisc + invDisc) * 10000) / gross) : 0;
    const needsApproval: ApprovalReason[] = [];
    if (!can('discount_unlimited') && bps > settings.cashierMaxDiscountBps)
      needsApproval.push('discount');
    const cust = draft.customerId ? customers.find((c) => c.id === draft.customerId) : undefined;
    return {
      lines,
      grossTotal: paisa(gross),
      lineDiscounts: paisa(lineDisc),
      subtotal: t.subtotal,
      invoiceDiscount: paisa(invDisc),
      total: t.total,
      effectiveDiscountBps: bps,
      needsApproval,
      customerBalance: cust ? paisa(customerBalance(cust.id)) : null,
      creditLimit: cust?.creditLimit ?? null,
    };
  };

  const view = (inv: Invoice): InvoiceView => ({
    invoice: inv,
    customerName: inv.customerId
      ? (customers.find((c) => c.id === inv.customerId)?.name ?? null)
      : null,
    cashierName: users.find((u) => u.id === inv.cashierId)?.displayName ?? '—',
    originalInvoiceNo: inv.originalSaleId
      ? (invoices.find((i) => i.id === inv.originalSaleId)?.invoiceNo ?? null)
      : null,
  });

  const seal = (
    kind: Invoice['kind'],
    lines: Omit<SaleLine, 'saleId' | 'id' | 'createdAt' | 'lineNo'>[],
    payments: { method: PaymentMethod; amount: number; reference?: string | null }[],
    meta: {
      customerId: string | null;
      invoiceDiscount: number;
      note: string | null;
      originalSaleId: string | null;
      saleId?: string;
    },
  ): Invoice => {
    const s = needSession();
    const sh = shop ?? fail('NOT_SETUP', 'Shop not set up');
    const saleId = meta.saleId ?? newId();
    const t = now();
    const seq = invoices.length + 1;
    const subtotal = sum(lines.map((l) => l.lineTotal));
    const unsealed = cast<Omit<Invoice, 'prevHash' | 'hash'>>({
      id: saleId,
      deviceId: sh.deviceId,
      seq,
      invoiceNo: formatInvoiceNo(sh.invoicePrefix, seq),
      kind,
      originalSaleId: meta.originalSaleId,
      branchId: sh.branchId,
      customerId: meta.customerId,
      cashierId: s.user.id,
      subtotal,
      discountTotal: meta.invoiceDiscount,
      total: subtotal - meta.invoiceDiscount,
      note: meta.note,
      createdAt: t,
      hashVersion: 1,
      lines: lines.map((l, i) => ({ ...l, id: newId(), saleId, lineNo: i + 1, createdAt: t })),
      payments: payments.map((p) => ({
        id: newId(),
        saleId,
        method: p.method,
        amount: p.amount,
        reference: p.reference ?? null,
        createdAt: t,
      })),
    });
    const sealed = sealInvoice(prevHash, unsealed);
    invoices.push(sealed);
    prevHash = sealed.hash;
    return sealed;
  };

  const returnedQty = (saleId: string): Map<string, { qty: number; discount: number }> => {
    const m = new Map<string, { qty: number; discount: number }>();
    const orig = invoices.find((i) => i.id === saleId);
    if (!orig) return m;
    for (const r of invoices.filter((i) => i.originalSaleId === saleId)) {
      for (const l of r.lines) {
        const src = orig.lines.find((o) => o.lineNo === l.lineNo);
        if (!src) continue;
        const cur = m.get(src.id) ?? { qty: 0, discount: 0 };
        m.set(src.id, {
          qty: cur.qty + Math.abs(l.quantity),
          discount: cur.discount + Math.abs(l.discountAmount),
        });
      }
    }
    return m;
  };

  const returnableLines = (orig: Invoice): ReturnableLine[] => {
    const rq = returnedQty(orig.id);
    return orig.lines.map((l) => {
      const done = rq.get(l.id)?.qty ?? 0;
      return {
        lineId: l.id,
        lineNo: l.lineNo,
        description: l.description,
        soldQty: l.quantity,
        returnedQty: done,
        remainingQty: l.quantity - done,
        unitPrice: l.unitPrice,
      };
    });
  };

  const planReturn = (originalSaleId: string, pick: { lineId: string; quantity: number }[]) => {
    const orig =
      invoices.find((i) => i.id === originalSaleId) ?? fail('NOT_FOUND', 'Invoice not found');
    if (orig.kind !== 'sale') fail('RETURN_NOT_ALLOWED', 'Only sales can be returned');
    const rq = returnedQty(orig.id);
    const lines: Omit<SaleLine, 'saleId' | 'id' | 'createdAt' | 'lineNo'>[] = [];
    for (const p of pick) {
      if (p.quantity <= 0) continue;
      const src = orig.lines.find((l) => l.id === p.lineId) ?? fail('NOT_FOUND', 'Line not found');
      const done = rq.get(src.id) ?? { qty: 0, discount: 0 };
      const remaining = src.quantity - done.qty;
      if (p.quantity > remaining)
        fail('ALREADY_RETURNED', 'More than remaining quantity', { remaining });
      // discount share: proportional, the final unit takes the remainder so it always nets to zero
      const share =
        p.quantity === remaining
          ? src.discountAmount - done.discount
          : Math.floor((src.discountAmount * p.quantity) / src.quantity);
      lines.push({
        productId: src.productId,
        phoneUnitId: src.phoneUnitId,
        variantId: src.variantId,
        description: src.description,
        quantity: -p.quantity,
        unitPrice: src.unitPrice,
        costPrice: src.costPrice,
        discountAmount: paisa(-share),
        lineTotal: paisa(-(p.quantity * src.unitPrice - share)),
      });
    }
    if (lines.length === 0) fail('VALIDATION', 'Nothing selected to return');
    const subtotal = sum(lines.map((l) => l.lineTotal));
    const origSub = orig.subtotal || 1;
    const invDisc =
      orig.discountTotal === 0
        ? 0
        : Math.floor((orig.discountTotal * Math.abs(subtotal)) / origSub);
    return { orig, lines, subtotal, discountTotal: -invDisc, total: subtotal + invDisc };
  };

  const applyReturnStock = (inv: Invoice): void => {
    for (const l of inv.lines) {
      if (l.phoneUnitId) unitInStock.set(l.phoneUnitId, true);
      else if (l.variantId)
        variantQty.set(l.variantId, (variantQty.get(l.variantId) ?? 0) + Math.abs(l.quantity));
    }
  };

  const finishReturn = (
    kind: 'return' | 'void',
    plan: ReturnType<typeof planReturn>,
    refund: PaymentInput[],
    reason: string,
    saleId?: string,
  ): Invoice => {
    const payments = refund.map((p) => ({
      method: p.method,
      amount: -p.amount,
      reference: p.reference ?? null,
    }));
    assertPaymentsMatchTotal(
      paisa(plan.total),
      payments.map((p) => ({ method: p.method, amount: paisa(p.amount) })),
    );
    if (payments.some((p) => p.method === 'khata') && !plan.orig.customerId)
      fail('KHATA_NEEDS_CUSTOMER', 'Khata refund needs a customer');
    const inv = seal(kind, plan.lines, payments, {
      customerId: plan.orig.customerId,
      invoiceDiscount: plan.discountTotal,
      note: reason,
      originalSaleId: plan.orig.id,
      ...(saleId ? { saleId } : {}),
    });
    applyReturnStock(inv);
    for (const p of inv.payments) {
      if (p.method === 'khata' && inv.customerId)
        addLedger({
          customerId: inv.customerId,
          type: 'return_credit',
          amount: p.amount,
          saleId: inv.id,
          note: reason,
        });
    }
    return inv;
  };

  const returnGuard = (token: string | undefined, reason: ApprovalReason): void => {
    require('sell');
    if (!can('return_void')) consumeApproval(token, reason);
  };

  // ---------------- API ----------------
  const service: PosService = {
    setup: {
      isSetUp: () => Promise.resolve(shop !== null),
      firstRun: (input) => {
        if (shop) return Promise.reject(new ServiceError('ALREADY_SETUP', 'Already set up'));
        const t = now();
        shop = {
          deviceId: newId(),
          branchId: newId(),
          branchName: input.branchName,
          invoicePrefix: input.invoicePrefix,
          createdAt: t,
          isDemo: false,
        };
        settings = { ...settings, shopName: input.shopName };
        users.push({
          ...cast<User>({
            id: newId(),
            username: input.owner.username,
            displayName: input.owner.displayName,
            role: 'owner',
            isActive: true,
            createdAt: t,
            updatedAt: t,
          }),
          pin: input.owner.pin,
        });
        return Promise.resolve(shop);
      },
      getShop: () =>
        shop ? Promise.resolve(shop) : Promise.reject(new ServiceError('NOT_SETUP', 'Not set up')),
    },
    settings: {
      get: () => Promise.resolve(settings),
      update: (patch) => {
        require('manage_settings');
        settings = { ...settings, ...patch };
        return Promise.resolve(settings);
      },
    },
    auth: {
      listLoginUsers: () =>
        Promise.resolve(
          users
            .filter((u) => u.isActive)
            .map((u) => ({ username: u.username, displayName: u.displayName, role: u.role })),
        ),
      login: (username, pin) => {
        const f = fails.get(username) ?? { n: 0, until: 0 };
        if (f.until > now())
          return Promise.reject(
            new ServiceError('LOGIN_LOCKED', 'Too many attempts', {
              retryAfterMs: f.until - now(),
            }),
          );
        const u = users.find((x) => x.username === username && x.isActive);
        if (!u || u.pin !== pin) {
          f.n += 1;
          if (f.n >= 5) {
            f.n = 0;
            f.until = now() + 30_000;
          }
          fails.set(username, f);
          return Promise.reject(new ServiceError('INVALID_CREDENTIALS', 'Wrong username or PIN'));
        }
        fails.delete(username);
        session = { user: publicUser(u), startedAt: now() };
        return Promise.resolve(session);
      },
      logout: () => {
        session = null;
      },
      current: () => session,
      can,
      requestApproval: (pin) => {
        const approver = users.find(
          (u) => (u.role === 'manager' || u.role === 'owner') && u.pin === pin,
        );
        if (!approver)
          return Promise.reject(new ServiceError('APPROVAL_INVALID', 'Wrong manager PIN'));
        const token = newId();
        const expiresAt = now() + 60_000;
        grants.set(token, { expiresAt, username: approver.username });
        const g: ApprovalGrant = { token, approverUsername: approver.username, expiresAt };
        return Promise.resolve(g);
      },
      changePin: (oldPin, newPin) => {
        const s = needSession();
        const u = users.find((x) => x.id === s.user.id);
        if (!u || u.pin !== oldPin)
          return Promise.reject(new ServiceError('INVALID_CREDENTIALS', 'Wrong PIN'));
        if (!/^\d{4,6}$/.test(newPin))
          return Promise.reject(new ServiceError('VALIDATION', 'PIN must be 4-6 digits'));
        u.pin = newPin;
        return Promise.resolve();
      },
      listUsers: () => {
        require('manage_users');
        return Promise.resolve(users.map(publicUser));
      },
      createUser: (i) => {
        require('manage_users');
        if (users.some((u) => u.username === i.username))
          return Promise.reject(
            new ServiceError('DUPLICATE', 'Username taken', { field: 'username' }),
          );
        const t = now();
        const u: MockUser = {
          ...cast<User>({
            id: newId(),
            username: i.username,
            displayName: i.displayName,
            role: i.role,
            isActive: true,
            createdAt: t,
            updatedAt: t,
          }),
          pin: i.pin,
        };
        users.push(u);
        return Promise.resolve(publicUser(u));
      },
    },
    catalog: {
      search: (query, o = {}) => {
        const q = query.trim().toLowerCase();
        const limit = o.limit ?? 20;
        if (!q) return Promise.resolve([]);
        const hits: CatalogHit[] = [];
        for (const u of units) {
          const v = unitView(u);
          if (o.inStockOnly && !v.inStock) continue;
          if (u.imei1 === q || u.imei2 === q)
            hits.push({ kind: 'phone_unit', matchedBy: 'imei', item: v });
          else if (u.serial?.toLowerCase() === q)
            hits.push({ kind: 'phone_unit', matchedBy: 'serial', item: v });
        }
        for (const va of variants) {
          const v = variantView(va);
          if (o.inStockOnly && v.onHand <= 0) continue;
          if (va.barcode === q) hits.push({ kind: 'variant', matchedBy: 'barcode', item: v });
          else if (va.sku.toLowerCase() === q)
            hits.push({ kind: 'variant', matchedBy: 'sku', item: v });
        }
        if (hits.length === 0) {
          const terms = q.split(/\s+/);
          const match = (s: string): boolean => terms.every((t) => s.toLowerCase().includes(t));
          for (const u of units) {
            const v = unitView(u);
            if (o.inStockOnly && !v.inStock) continue;
            if (match(`${v.label} ${u.colour ?? ''} ${u.imei1 ?? ''}`))
              hits.push({ kind: 'phone_unit', matchedBy: 'name', item: v });
          }
          for (const va of variants) {
            const v = variantView(va);
            if (o.inStockOnly && v.onHand <= 0) continue;
            if (match(`${v.product.brand} ${v.label} ${va.sku} ${va.barcode ?? ''}`))
              hits.push({ kind: 'variant', matchedBy: 'name', item: v });
          }
        }
        return Promise.resolve(hits.slice(0, limit));
      },
      listPhones: (f = {}) => {
        require('view_catalog');
        const q = f.q?.trim().toLowerCase();
        return Promise.resolve(
          units
            .map(unitView)
            .filter((v) => (f.inStock === undefined ? true : v.inStock === f.inStock))
            .filter((v) => (f.pta ? v.unit.ptaStatus === f.pta : true))
            .filter((v) => (f.condition ? v.unit.condition === f.condition : true))
            .filter((v) =>
              q
                ? `${v.label} ${v.unit.imei1 ?? ''} ${v.unit.imei2 ?? ''} ${v.unit.colour ?? ''}`
                    .toLowerCase()
                    .includes(q)
                : true,
            ),
        );
      },
      listAccessories: (f = {}) => {
        require('view_catalog');
        const q = f.q?.trim().toLowerCase();
        return Promise.resolve(
          variants
            .map(variantView)
            .filter((v) => (f.lowStockOnly ? v.lowStock : true))
            .filter((v) =>
              q
                ? `${v.product.brand} ${v.label} ${v.variant.sku} ${v.variant.barcode ?? ''}`
                    .toLowerCase()
                    .includes(q)
                : true,
            ),
        );
      },
      createPhoneUnit: (i) => {
        require('edit_catalog');
        try {
          return Promise.resolve(unitView(addPhone(i, i.openingStock !== false)));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
      createAccessory: (i) => {
        require('edit_catalog');
        try {
          return Promise.resolve(variantView(addVariantRow(i)));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
      updatePhoneUnit: (id, p) => {
        require('edit_catalog');
        const i = units.findIndex((u) => u.id === id);
        const cur = units[i];
        if (!cur) return Promise.reject(new ServiceError('NOT_FOUND', 'Unit not found'));
        const next = { ...cur, ...p, updatedAt: now() } as PhoneUnit;
        units[i] = next;
        return Promise.resolve(unitView(next));
      },
      updateVariant: (id, p) => {
        require('edit_catalog');
        const i = variants.findIndex((v) => v.id === id);
        const cur = variants[i];
        if (!cur) return Promise.reject(new ServiceError('NOT_FOUND', 'Accessory not found'));
        const next = { ...cur, ...p, updatedAt: now() } as AccessoryVariant;
        variants[i] = next;
        return Promise.resolve(variantView(next));
      },
      adjustStock: ({ variantId, delta, reason }) => {
        require('adjust_stock');
        const v = variants.find((x) => x.id === variantId);
        if (!v) return Promise.reject(new ServiceError('NOT_FOUND', 'Accessory not found'));
        if (!reason.trim() || delta === 0)
          return Promise.reject(
            new ServiceError('VALIDATION', 'Reason and a non-zero change are required'),
          );
        variantQty.set(v.id, (variantQty.get(v.id) ?? 0) + delta);
        return Promise.resolve(variantView(v));
      },
    },
    purchasing: {
      listSuppliers: () => {
        require('receive_stock');
        return Promise.resolve(
          suppliers.map((s): PartyBalance<Supplier> => ({
            party: s,
            balance: paisa(supplierBalance(s.id)),
            lastActivityAt: supplierLedger.filter((e) => e.supplierId === s.id).at(-1)?.at ?? null,
          })),
        );
      },
      createSupplier: (i) => {
        require('receive_stock');
        const t = now();
        const s: Supplier = cast({
          id: newId(),
          name: i.name,
          phone: i.phone ?? null,
          address: i.address ?? null,
          notes: null,
          isActive: true,
          createdAt: t,
          updatedAt: t,
        });
        suppliers.push(s);
        return Promise.resolve(s);
      },
      receive: (i: ReceivePurchaseInput) => {
        require('receive_stock');
        if (!suppliers.some((s) => s.id === i.supplierId))
          return Promise.reject(new ServiceError('NOT_FOUND', 'Supplier not found'));
        if (i.phones.length === 0 && i.accessories.length === 0)
          return Promise.reject(new ServiceError('VALIDATION', 'Nothing to receive'));
        try {
          const ids: string[] = [];
          let total = 0;
          for (const p of i.phones) {
            const u = addPhone({ ...p, supplierId: i.supplierId }, true);
            ids.push(u.id);
            total += p.costPrice;
          }
          for (const a of i.accessories) {
            const idx = variants.findIndex((v) => v.id === a.variantId);
            const v = variants[idx];
            if (!v) throw new ServiceError('NOT_FOUND', 'Accessory not found');
            variantQty.set(v.id, (variantQty.get(v.id) ?? 0) + a.quantity);
            variants[idx] = { ...v, costPrice: paisa(a.unitCost), updatedAt: now() as never };
            total += a.quantity * a.unitCost;
          }
          supplierLedger.push({ supplierId: i.supplierId, amount: total, at: now() });
          if (i.paidNow && i.paidNow.amount > 0)
            supplierLedger.push({ supplierId: i.supplierId, amount: -i.paidNow.amount, at: now() });
          const r: PurchaseResult = {
            purchase: cast({
              id: newId(),
              supplierId: i.supplierId,
              branchId: shop?.branchId,
              kind: 'purchase',
              referenceNo: i.referenceNo ?? null,
              total,
              note: i.note ?? null,
              createdBy: needSession().user.id,
              createdAt: now(),
            }),
            phoneUnitIds: ids,
            supplierBalance: paisa(supplierBalance(i.supplierId)),
          };
          return Promise.resolve(r);
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
      paySupplier: ({ supplierId, amount }) => {
        require('receive_stock');
        supplierLedger.push({ supplierId, amount: -amount, at: now() });
        return Promise.resolve(paisa(supplierBalance(supplierId)));
      },
    },
    checkout: {
      preview: (d) => {
        try {
          require('sell');
          return Promise.resolve(buildPreview(d));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
      commit: (input: CommitSaleInput) => {
        try {
          require('sell');
          if (input.saleId && idempotent.has(input.saleId))
            return Promise.resolve(idempotent.get(input.saleId) as Invoice);
          const pv = buildPreview(input);
          const khata = sum(
            input.payments.filter((p) => p.method === 'khata').map((p) => p.amount),
          );
          if (khata > 0 && !input.customerId)
            fail('KHATA_NEEDS_CUSTOMER', 'Pick a customer for khata');
          assertPaymentsMatchTotal(
            pv.total,
            input.payments.map((p) => ({ method: p.method, amount: paisa(p.amount) })),
          );
          const reasons = [...pv.needsApproval];
          if (
            khata > 0 &&
            pv.creditLimit !== null &&
            !can('discount_unlimited') &&
            (pv.customerBalance ?? 0) + khata > pv.creditLimit
          )
            reasons.push('credit_limit');
          const firstReason = reasons[0];
          if (firstReason) consumeApproval(input.approvalToken, firstReason);
          const lines = pv.lines.map((pl, idx) => {
            const src = input.lines[idx];
            const unit = src?.phoneUnitId ? units.find((u) => u.id === src.phoneUnitId) : undefined;
            const va = src?.variantId ? variants.find((v) => v.id === src.variantId) : undefined;
            return {
              productId: (unit?.productId ?? va?.productId) as never,
              phoneUnitId: (unit?.id ?? null) as never,
              variantId: (va?.id ?? null) as never,
              description: pl.description,
              quantity: pl.quantity,
              unitPrice: pl.unitPrice,
              costPrice: paisa(unit?.costPrice ?? va?.costPrice ?? 0),
              discountAmount: pl.discountAmount,
              lineTotal: pl.lineTotal,
            };
          });
          const inv = seal('sale', lines, input.payments, {
            customerId: input.customerId ?? null,
            invoiceDiscount: input.invoiceDiscount ?? 0,
            note: input.note ?? null,
            originalSaleId: null,
            ...(input.saleId ? { saleId: input.saleId } : {}),
          });
          for (const l of inv.lines) {
            if (l.phoneUnitId) unitInStock.set(l.phoneUnitId, false);
            else if (l.variantId)
              variantQty.set(l.variantId, (variantQty.get(l.variantId) ?? 0) - l.quantity);
          }
          if (khata > 0 && inv.customerId)
            addLedger({
              customerId: inv.customerId,
              type: 'sale_credit',
              amount: khata,
              saleId: inv.id,
            });
          if (input.saleId) idempotent.set(input.saleId, inv);
          return Promise.resolve(inv);
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
      getInvoice: (idOrNo) => {
        const inv = invoices.find((i) => i.id === idOrNo || i.invoiceNo === idOrNo);
        return inv
          ? Promise.resolve(view(inv))
          : Promise.reject(new ServiceError('NOT_FOUND', 'Invoice not found'));
      },
      listInvoices: (f = {}) => {
        const q = f.q?.trim().toLowerCase();
        const rows = invoices
          .filter((i) => (f.fromMs === undefined ? true : i.createdAt >= f.fromMs))
          .filter((i) => (f.toMs === undefined ? true : i.createdAt < f.toMs))
          .filter((i) => (f.kind ? i.kind === f.kind : true))
          .filter((i) => (f.customerId ? i.customerId === f.customerId : true))
          .filter((i) => {
            if (!q) return true;
            if (i.invoiceNo.toLowerCase().includes(q)) return true;
            return i.lines.some((l) => {
              const u = l.phoneUnitId ? units.find((x) => x.id === l.phoneUnitId) : undefined;
              return u ? u.imei1 === q || u.imei2 === q : false;
            });
          })
          .sort((a, b) => b.seq - a.seq)
          .slice(0, f.limit ?? 200)
          .map((i): InvoiceSummary => {
            const v = view(i);
            return {
              id: i.id,
              invoiceNo: i.invoiceNo,
              kind: i.kind,
              createdAt: i.createdAt,
              customerName: v.customerName,
              cashierName: v.cashierName,
              total: i.total,
              returnedTotal: paisa(
                sum(
                  invoices.filter((r) => r.originalSaleId === i.id).map((r) => Math.abs(r.total)),
                ),
              ),
            };
          });
        return Promise.resolve(rows);
      },
      previewReturn: (id, pick) => {
        try {
          const orig = invoices.find((i) => i.id === id) ?? fail('NOT_FOUND', 'Invoice not found');
          const rl = returnableLines(orig);
          const effective = pick.filter((p) => p.quantity > 0);
          const plan = effective.length > 0 ? planReturn(id, effective) : null;
          const total = plan ? plan.total : 0;
          const weights = orig.payments.map((p) => p.amount);
          const suggested: PaymentInput[] =
            plan && total !== 0 && weights.length > 0
              ? allocate(paisa(total), weights).map((amount, i) => ({
                  method: (orig.payments[i] as { method: PaymentMethod }).method,
                  amount,
                }))
              : [];
          const r: ReturnPreview = {
            original: view(orig),
            lines: rl,
            total: paisa(total),
            suggestedRefund: suggested.filter((s) => s.amount !== 0),
          };
          return Promise.resolve(r);
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
      createReturn: (i) => {
        try {
          returnGuard(i.approvalToken, 'return');
          const plan = planReturn(i.originalSaleId, i.lines);
          if (!i.reason.trim()) fail('VALIDATION', 'Reason is required');
          return Promise.resolve(finishReturn('return', plan, i.refund, i.reason, i.saleId));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
      voidSale: (i) => {
        try {
          returnGuard(i.approvalToken, 'void');
          const orig =
            invoices.find((x) => x.id === i.originalSaleId) ??
            fail('NOT_FOUND', 'Invoice not found');
          const remaining = returnableLines(orig)
            .filter((l) => l.remainingQty > 0)
            .map((l) => ({ lineId: l.lineId, quantity: l.remainingQty }));
          if (remaining.length === 0) fail('ALREADY_RETURNED', 'Nothing left to void');
          const plan = planReturn(orig.id, remaining);
          const refunded = sum(
            invoices
              .filter((r) => r.originalSaleId === orig.id)
              .flatMap((r) => r.payments.map((p) => Math.abs(p.amount))),
          );
          const weights = orig.payments.map((p) => p.amount);
          const parts = allocate(paisa(Math.abs(plan.total)), weights);
          void refunded;
          const refund: PaymentInput[] = parts
            .map((amount, idx) => ({
              method: (orig.payments[idx] as { method: PaymentMethod }).method,
              amount,
            }))
            .filter((p) => p.amount > 0);
          return Promise.resolve(finishReturn('void', plan, refund, i.reason, i.saleId));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    },
    khata: {
      listCustomers: (o = {}) => {
        require('receive_khata');
        const q = o.q?.trim().toLowerCase();
        return Promise.resolve(
          customers
            .filter((c) => (q ? `${c.name} ${c.phone ?? ''}`.toLowerCase().includes(q) : true))
            .map((c): PartyBalance<Customer> => ({
              party: c,
              balance: paisa(customerBalance(c.id)),
              lastActivityAt: ledger.filter((e) => e.customerId === c.id).at(-1)?.createdAt ?? null,
            }))
            .filter((r) => (o.withBalanceOnly ? r.balance !== 0 : true)),
        );
      },
      createCustomer: (i) => {
        require('receive_khata');
        if (!i.name.trim())
          return Promise.reject(new ServiceError('VALIDATION', 'Name is required'));
        const t = now();
        const c: Customer = cast({
          id: newId(),
          name: i.name.trim(),
          phone: i.phone || null,
          cnic: i.cnic || null,
          address: i.address || null,
          creditLimit: i.creditLimit ?? null,
          notes: null,
          isActive: true,
          createdAt: t,
          updatedAt: t,
        });
        customers.push(c);
        if (i.openingBalance && i.openingBalance > 0)
          addLedger({ customerId: c.id, type: 'opening_balance', amount: i.openingBalance });
        return Promise.resolve(c);
      },
      updateCustomer: (id, p) => {
        require('receive_khata');
        const idx = customers.findIndex((c) => c.id === id);
        const cur = customers[idx];
        if (!cur) return Promise.reject(new ServiceError('NOT_FOUND', 'Customer not found'));
        const next = { ...cur, ...p, updatedAt: now() } as Customer;
        customers[idx] = next;
        return Promise.resolve(next);
      },
      getLedger: (customerId, o = {}) => {
        require('receive_khata');
        const customer = customers.find((c) => c.id === customerId);
        if (!customer) return Promise.reject(new ServiceError('NOT_FOUND', 'Customer not found'));
        let running = 0;
        const all: LedgerLine[] = ledger
          .filter((e) => e.customerId === customerId)
          .map((entry) => {
            running += entry.amount;
            return {
              entry,
              runningBalance: paisa(running),
              invoiceNo: entry.saleId
                ? (invoices.find((i) => i.id === entry.saleId)?.invoiceNo ?? null)
                : null,
            };
          });
        const before = o.beforeCreatedAt;
        const lines = all
          .filter((l) => (before ? l.entry.createdAt < before : true))
          .slice(-(o.limit ?? 500))
          .reverse();
        return Promise.resolve({ customer, balance: paisa(running), lines });
      },
      receivePayment: ({ customerId, amount, method, note }) => {
        require('receive_khata');
        const bal = customerBalance(customerId);
        if (amount <= 0 || amount > bal)
          return Promise.reject(
            new ServiceError('VALIDATION', 'Amount must be between 1 paisa and the balance'),
          );
        addLedger({
          customerId,
          type: 'payment_received',
          amount: -amount,
          method,
          note: note ?? null,
        });
        return Promise.resolve(paisa(customerBalance(customerId)));
      },
      totals: () => {
        const bal = customers.map((c) => customerBalance(c.id)).filter((b) => b > 0);
        return Promise.resolve({ receivable: paisa(sum(bal)), customersOwing: bal.length });
      },
    },
    reports: {
      summary: (range) => {
        try {
          require('view_reports');
          const inRange = invoices.filter(
            (i) => i.createdAt >= range.fromMs && i.createdAt < range.toMs,
          );
          const sales = inRange.filter((i) => i.kind === 'sale');
          const rets = inRange.filter((i) => i.kind !== 'sale');
          const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<
            PaymentMethod,
            number
          >;
          for (const i of inRange) for (const p of i.payments) byMethod[p.method] += p.amount;
          const receipts = ledger.filter(
            (e) =>
              e.type === 'payment_received' &&
              e.createdAt >= range.fromMs &&
              e.createdAt < range.toMs,
          );
          const gross = sum(sales.flatMap((i) => i.lines.map((l) => l.quantity * l.unitPrice)));
          const discounts =
            sum(sales.flatMap((i) => i.lines.map((l) => l.discountAmount))) +
            sum(sales.map((i) => i.discountTotal));
          const netSales = sum(sales.map((i) => i.total));
          const returnsTotal = sum(rets.map((i) => Math.abs(i.total)));
          const cogs = sum(inRange.flatMap((i) => i.lines.map((l) => l.quantity * l.costPrice)));
          const cashReceipts = sum(
            receipts.filter((e) => e.method === 'cash').map((e) => Math.abs(e.amount)),
          );
          const r: PeriodSummary = {
            range,
            salesCount: sales.length,
            returnsCount: rets.length,
            grossSales: paisa(gross),
            discounts: paisa(discounts),
            netSales: paisa(netSales),
            returnsTotal: paisa(returnsTotal),
            netRevenue: paisa(netSales - returnsTotal),
            byMethod: Object.fromEntries(
              Object.entries(byMethod).map(([k, v]) => [k, paisa(v)]),
            ) as Record<PaymentMethod, Paisa>,
            khataCollected: paisa(sum(receipts.map((e) => Math.abs(e.amount)))),
            cashInDrawer: paisa(byMethod.cash + cashReceipts),
            estimatedCogs: paisa(cogs),
            estimatedProfit: paisa(netSales - returnsTotal - cogs),
            lowStock: variants.map(variantView).filter((v) => v.lowStock),
          };
          return Promise.resolve(r);
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    },
    integrity: {
      verifyChain: () => {
        const r = verifyChain(invoices);
        if (r.ok)
          return Promise.resolve({
            ok: true as const,
            count: r.count,
            headSeq: r.headSeq,
            headHash: r.headHash,
          });
        return Promise.resolve({
          ok: false as const,
          reason: r.reason,
          seq: invoices[r.index]?.seq ?? null,
          invoiceNo: invoices[r.index]?.invoiceNo ?? null,
        });
      },
      checks: () =>
        Promise.resolve({
          salePaymentMismatch: 0,
          saleLineMismatch: 0,
          badPhoneUnits: 0,
          unsentOutbox: 0,
        }),
    },
  };

  const seed = (): Promise<void> =>
    seedMock(
      service,
      (v) => {
        shop = shop && { ...shop, isDemo: v };
      },
      (v) => {
        session = v;
      },
    );
  return { service, seed };
}

/** Empty service: needs the first-run wizard. */
export const createMockPosService = (): PosService => build().service;

/** Service pre-loaded with demo shop data (users owner/1234, manager/2345, cashier/3456). */
export async function createDemoMockPosService(): Promise<PosService> {
  const { service, seed } = build();
  await seed();
  return service;
}

// ------------------------------------------------------------------------------------------
// Demo data (kept small). The real seed lives in @pos/db/service; this only feeds the mock.
// ------------------------------------------------------------------------------------------
const rs = (n: number): number => n * 100;

function imei(counter: number): string {
  const base = `35693803${String(counter).padStart(6, '0')}`;
  let total = 0;
  for (let i = 0; i < base.length; i++) {
    let d = Number(base[base.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return base + String((10 - (total % 10)) % 10);
}

const PHONES: [
  string,
  string,
  number,
  number,
  'approved' | 'non_pta' | 'jv',
  'new' | 'used' | 'open_box',
  number,
  number,
  string,
][] = [
  ['Samsung', 'Galaxy A15', 4, 128, 'approved', 'new', 41500, 44500, 'Black'],
  ['Samsung', 'Galaxy A35', 8, 256, 'approved', 'new', 88000, 94000, 'Navy'],
  ['Samsung', 'Galaxy A55', 8, 256, 'approved', 'new', 78000, 85000, 'Lilac'],
  ['Samsung', 'Galaxy S24', 8, 256, 'approved', 'new', 215000, 229000, 'Grey'],
  ['Infinix', 'Hot 40i', 8, 256, 'approved', 'new', 33500, 36500, 'Green'],
  ['Infinix', 'Note 40', 8, 256, 'approved', 'new', 54000, 58500, 'Gold'],
  ['Tecno', 'Spark 20', 8, 128, 'approved', 'new', 31000, 34000, 'White'],
  ['Xiaomi', 'Redmi Note 13', 8, 256, 'approved', 'new', 52000, 56000, 'Blue'],
  ['Apple', 'iPhone 13', 4, 128, 'non_pta', 'used', 118000, 127000, 'Midnight'],
  ['Apple', 'iPhone 14 Pro', 6, 256, 'jv', 'open_box', 265000, 282000, 'Purple'],
];

const ACCESSORIES: [string, string, string, string, number, number, number][] = [
  ['Fast Charger 25W Type-C', 'Universal', 'Black', 'CHG-25-BLK', 900, 1500, 14],
  ['Fast Charger 25W Type-C', 'Universal', 'White', 'CHG-25-WHT', 900, 1500, 9],
  ['GaN Charger 65W', 'Universal', 'Black', 'CHG-65-BLK', 3200, 4800, 6],
  ['Cable Type-C 1m', 'Universal', 'Black', 'CBL-C-1M', 250, 500, 40],
  ['Cable Lightning 1m', 'iPhone', 'White', 'CBL-L-1M', 600, 1100, 18],
  ['Wired Earphones', 'Universal', 'White', 'AUD-WRD', 300, 600, 25],
  ['Earbuds Pro', 'Universal', 'Black', 'AUD-EBP', 1800, 2800, 7],
  ['Power Bank 10000mAh', 'Universal', 'Black', 'PWR-10K', 2600, 3800, 8],
  ['Power Bank 20000mAh', 'Universal', 'Black', 'PWR-20K', 4200, 5900, 2],
  ['Tempered Glass', 'iPhone 13', 'Clear', 'GLS-IP13', 150, 500, 30],
  ['Tempered Glass', 'iPhone 14 Pro', 'Clear', 'GLS-IP14P', 180, 600, 3],
  ['Tempered Glass', 'Galaxy A55', 'Clear', 'GLS-A55', 120, 450, 22],
  ['Back Cover', 'Galaxy A55', 'Black', 'CVR-A55', 200, 600, 12],
  ['Memory Card 64GB', 'Universal', '', 'MEM-64', 900, 1400, 10],
];

async function seedMock(
  s: PosService,
  markDemo: (v: boolean) => void,
  setSession: (v: Session | null) => void,
): Promise<void> {
  await s.setup.firstRun({
    shopName: 'Al-Madina Mobile Centre',
    branchName: 'Main Counter',
    invoicePrefix: 'A',
    owner: { username: 'owner', displayName: 'Owner', pin: '1234' },
  });
  markDemo(true);
  await s.auth.login('owner', '1234');
  await s.auth.createUser({
    username: 'manager',
    displayName: 'Manager',
    role: 'manager',
    pin: '2345',
  });
  await s.auth.createUser({
    username: 'cashier',
    displayName: 'Cashier',
    role: 'cashier',
    pin: '3456',
  });
  const sup = await s.purchasing.createSupplier({
    name: 'Hafeez Centre Traders',
    phone: '03211234567',
  });
  await s.purchasing.createSupplier({ name: 'Karachi Accessories House', address: 'Saddar' });
  let n = 100;
  for (const [brand, name, ram, gb, pta, cond, cost, sale, colour] of PHONES) {
    n += 1;
    await s.catalog.createPhoneUnit({
      product: { brand, name, category: 'Smartphone' },
      imei1: imei(n),
      colour,
      ramGb: ram,
      storageGb: gb,
      ptaStatus: pta,
      condition: cond,
      costPrice: rs(cost),
      salePrice: rs(sale),
      supplierId: sup.id,
      batteryHealthPct: cond === 'used' ? 86 : null,
    });
  }
  let b = 0;
  for (const [name, model, colour, sku, cost, sale, qty] of ACCESSORIES) {
    b += 1;
    await s.catalog.createAccessory({
      product: { brand: 'Generic', name, category: 'Accessory' },
      sku,
      barcode: `8961000${String(b).padStart(5, '0')}0`,
      model,
      colour: colour || null,
      costPrice: rs(cost),
      salePrice: rs(sale),
      reorderLevel: 5,
      openingQty: qty,
    });
  }
  const bilal = await s.khata.createCustomer({
    name: 'Bilal Ahmed',
    phone: '03001234567',
    cnic: '3520112345671',
    creditLimit: rs(50000),
    openingBalance: rs(12000),
  });
  await s.khata.createCustomer({ name: 'Ayesha Khan', phone: '03211234567' });
  await s.khata.createCustomer({
    name: 'Hamza Traders',
    phone: '03331234567',
    creditLimit: rs(200000),
    openingBalance: rs(45000),
  });
  await s.khata.createCustomer({ name: 'Sana Malik', phone: '03451234567' });
  // a few sales so Sales / Khata / Reports are not empty
  const acc = await s.catalog.listAccessories();
  const phones = await s.catalog.listPhones({ inStock: true });
  const charger = acc.find((v) => v.variant.sku === 'CHG-25-BLK');
  const glass = acc.find((v) => v.variant.sku === 'GLS-A55');
  const cable = acc.find((v) => v.variant.sku === 'CBL-C-1M');
  const a15 = phones[0];
  if (charger && glass && cable && a15) {
    await s.checkout.commit({
      lines: [{ variantId: charger.variant.id, quantity: 2 }],
      payments: [{ method: 'cash', amount: 2 * charger.variant.salePrice }],
    });
    await s.checkout.commit({
      lines: [
        { variantId: glass.variant.id, quantity: 1 },
        { variantId: cable.variant.id, quantity: 2 },
      ],
      payments: [
        { method: 'jazzcash', amount: glass.variant.salePrice + 2 * cable.variant.salePrice },
      ],
    });
    const price = a15.unit.salePrice - rs(500);
    await s.checkout.commit({
      lines: [{ phoneUnitId: a15.unit.id, quantity: 1, discountAmount: rs(500) }],
      customerId: bilal.id,
      payments: [
        { method: 'cash', amount: rs(20000) },
        { method: 'khata', amount: price - rs(20000) },
      ],
    });
  }
  s.auth.logout();
  setSession(null);
}
