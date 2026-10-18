import {
  MAX_QUANTITY_ANY,
  PaymentMethodSchema,
  ServiceError,
  isValidYmd,
  lineGross,
  maxQuantity,
  type LedgerEntry,
  type PartyBalance,
  type Paisa,
  type Purchase,
  type PurchasingApi,
  type Supplier,
  type SupplierLedgerLine,
} from '@pos/shared';
import { negPaisa, paisa } from '@pos/core';
import { WriteBatch } from './batch';
import { insertBatch, type BatchRec } from './batches';
import { createProductResolver, normalizePhone, stagePhoneUnit } from './catalog';
import { canDo, requirePermission, requireSession, type Ctx } from './deps';
import { guardApi, intIn, invalid, money, optPhone, optText, reqText } from './errors';
import { mapRow, type Raw } from './mappers';
import { loadShop } from './meta';
import { assertModule } from './modules';
import {
  insertLedger,
  insertMovement,
  insertPurchase,
  insertSupplier,
  loadVariantRec,
  requireSupplier,
  supplierBalance,
  updateVariant,
  type PurchaseRec,
  type SupplierRec,
  type VariantRec,
} from './queries';

const NON_KHATA = PaymentMethodSchema.exclude(['khata']);

export function createPurchasingApi(ctx: Ctx): PurchasingApi {
  return guardApi<PurchasingApi>({
    async listSuppliers() {
      requirePermission(ctx, 'view_catalog');
      const rows = await ctx.driver.query<Raw>(
        `SELECT s.*,
           COALESCE((SELECT SUM(amount) FROM ledger_entries WHERE supplier_id = s.id), 0) AS balance,
           (SELECT MAX(created_at) FROM ledger_entries WHERE supplier_id = s.id) AS last_activity_at
         FROM suppliers s WHERE s.is_active = 1 ORDER BY s.name`,
      );
      return rows.map((r): PartyBalance<Supplier> => {
        const { balance, last_activity_at: last, ...supplier } = r;
        return {
          party: mapRow<Supplier>(supplier),
          balance: paisa(Number(balance)),
          lastActivityAt: last === null || last === undefined ? null : Number(last),
        };
      });
    },

    async createSupplier(i) {
      requirePermission(ctx, 'receive_stock');
      const name = reqText(i.name, 'name', 1, 100);
      const phone = optPhone(i.phone, 'phone');
      const address = optText(i.address, 'address', 300);
      return ctx.lock(async () => {
        const at = ctx.clock();
        const rec: SupplierRec = {
          id: ctx.newId(),
          name,
          phone,
          address,
          notes: null,
          isActive: true,
          createdAt: at,
          updatedAt: at,
        };
        const b = new WriteBatch(ctx.newId, at);
        insertSupplier(b, rec);
        await b.commit(ctx.driver);
        return rec as unknown as Supplier;
      });
    },

    async receive(i) {
      const session = requirePermission(ctx, 'receive_stock');
      const shop = await loadShop(ctx.driver);
      const phones = i.phones ?? [];
      const accessories = i.accessories ?? [];
      if (phones.length === 0 && accessories.length === 0)
        throw invalid('items', 'A purchase needs at least one phone or accessory line');
      if (phones.length > 0) assertModule(shop.modules, 'imei');
      const referenceNo = optText(i.referenceNo, 'referenceNo', 60);
      const note = optText(i.note, 'note', 500);
      // validate everything up front and compute the total
      let total = 0;
      for (const p of phones) total += normalizePhone(p).costPrice;
      const lines: {
        variantId: string;
        quantity: number;
        unitCost: number;
        batch: { batchNo: string | null; expiryDate: string } | null;
      }[] = [];
      for (const [idx, a] of accessories.entries()) {
        if (typeof a.variantId !== 'string')
          throw invalid(`accessories.${idx}.variantId`, 'variantId is required');
        const quantity = intIn(a.quantity, `accessories.${idx}.quantity`, 1, MAX_QUANTITY_ANY);
        const unitCost = money(a.unitCost, `accessories.${idx}.unitCost`);
        const variant = await loadVariantRec(ctx.driver, a.variantId); // NOT_FOUND
        if (quantity > maxQuantity(variant.unitScale))
          throw invalid(`accessories.${idx}.quantity`, 'Quantity is larger than this item allows');
        let batch: { batchNo: string | null; expiryDate: string } | null = null;
        if (a.batch !== undefined && a.batch !== null) {
          assertModule(shop.modules, 'batch_expiry');
          if (!isValidYmd(a.batch.expiryDate))
            throw invalid(
              `accessories.${idx}.batch.expiryDate`,
              'Expiry date must be a real date written as YYYY-MM-DD',
            );
          batch = {
            batchNo: optText(a.batch.batchNo, `accessories.${idx}.batch.batchNo`, 60),
            expiryDate: a.batch.expiryDate,
          };
        }
        // unitCost is per priced unit (per kg for weighted items), quantity is in base units (grams)
        total += lineGross(quantity, unitCost, variant.unitScale);
        lines.push({ variantId: a.variantId, quantity, unitCost, batch });
      }
      const totalPaisa: Paisa = paisa(total);
      let paid = 0;
      let paidMethod: Exclude<NonNullable<typeof i.paidNow>['method'], 'khata'> | null = null;
      if (i.paidNow !== undefined && i.paidNow !== null) {
        const m = NON_KHATA.safeParse(i.paidNow.method);
        if (!m.success) throw invalid('paidNow.method', 'Pay-now method cannot be khata');
        paid = money(i.paidNow.amount, 'paidNow.amount', { allowZero: false });
        if (paid > totalPaisa)
          throw invalid('paidNow.amount', 'Paid amount exceeds the purchase total');
        paidMethod = m.data;
      }

      const out = await ctx.lock(async () => {
        await requireSupplier(ctx.driver, i.supplierId);
        const at = ctx.clock();
        const b = new WriteBatch(ctx.newId, at);
        const purchase: PurchaseRec = {
          id: ctx.newId(),
          supplierId: i.supplierId,
          branchId: shop.branchId,
          kind: 'purchase',
          referenceNo,
          total: totalPaisa,
          note,
          createdBy: session.user.id,
          createdAt: at,
        };
        insertPurchase(b, purchase);

        const resolveProduct = createProductResolver(ctx, b, at);
        const seen = new Set<string>();
        const phoneUnitIds: string[] = [];
        for (const p of phones) {
          const rec = await stagePhoneUnit(ctx, b, p, {
            at,
            branchId: shop.branchId,
            actorId: session.user.id,
            resolveProduct,
            defaultSupplierId: i.supplierId,
            stock: { type: 'purchase', purchaseId: purchase.id },
            seen,
          });
          phoneUnitIds.push(rec.id);
        }

        const variants = new Map<string, VariantRec>();
        for (const l of lines) {
          const cur = variants.get(l.variantId) ?? (await loadVariantRec(ctx.driver, l.variantId));
          variants.set(l.variantId, { ...cur, costPrice: l.unitCost, updatedAt: at });
          let batchId: string | null = null;
          if (l.batch !== null) {
            const rec: BatchRec = {
              id: ctx.newId(),
              variantId: l.variantId,
              branchId: shop.branchId,
              batchNo: l.batch.batchNo,
              expiryDate: l.batch.expiryDate,
              purchaseId: purchase.id,
              createdBy: session.user.id,
              createdAt: at,
            };
            insertBatch(b, rec);
            batchId = rec.id;
          }
          insertMovement(b, {
            id: ctx.newId(),
            branchId: shop.branchId,
            type: 'purchase',
            phoneUnitId: null,
            variantId: l.variantId,
            batchId,
            quantity: l.quantity,
            unitCost: l.unitCost,
            refType: 'purchase',
            refId: purchase.id,
            reason: null,
            createdBy: session.user.id,
            createdAt: at,
          });
        }
        for (const v of variants.values()) updateVariant(b, v); // latest cost price

        if (totalPaisa > 0)
          insertLedger(b, {
            id: ctx.newId(),
            customerId: null,
            supplierId: i.supplierId,
            type: 'purchase_credit',
            amount: totalPaisa,
            method: null,
            saleId: null,
            purchaseId: purchase.id,
            note: referenceNo,
            createdBy: session.user.id,
            createdAt: at,
          });
        if (paidMethod !== null)
          insertLedger(b, {
            id: ctx.newId(),
            customerId: null,
            supplierId: i.supplierId,
            type: 'payment_made',
            amount: -paid,
            method: paidMethod,
            saleId: null,
            purchaseId: purchase.id,
            note: null,
            createdBy: session.user.id,
            createdAt: at,
          });

        await ctx.assertCanSell({ action: 'purchase', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
        return { purchase, phoneUnitIds };
      });
      return {
        purchase: out.purchase as unknown as Purchase,
        phoneUnitIds: out.phoneUnitIds,
        supplierBalance: paisa(await supplierBalance(ctx.driver, i.supplierId)),
      };
    },

    async paySupplier(i) {
      const session = requirePermission(ctx, 'receive_stock');
      const amount = money(i.amount, 'amount', { allowZero: false });
      const method = NON_KHATA.safeParse(i.method);
      if (!method.success) throw invalid('method', 'Payment method cannot be khata');
      const note = optText(i.note, 'note', 500);
      await ctx.lock(async () => {
        await requireSupplier(ctx.driver, i.supplierId);
        const at = ctx.clock();
        const b = new WriteBatch(ctx.newId, at);
        insertLedger(b, {
          id: ctx.newId(),
          customerId: null,
          supplierId: i.supplierId,
          type: 'payment_made',
          amount: negPaisa(amount),
          method: method.data,
          saleId: null,
          purchaseId: null,
          note,
          createdBy: session.user.id,
          createdAt: at,
        });
        await b.commit(ctx.driver);
      });
      return paisa(await supplierBalance(ctx.driver, i.supplierId));
    },

    async getLedger(supplierId, o = {}) {
      requirePermission(ctx, 'receive_stock');
      const supplier = await requireSupplier(ctx.driver, supplierId); // NOT_FOUND
      const limit = o.limit === undefined ? 100 : intIn(o.limit, 'limit', 1, 1000);
      const before = o.beforeCreatedAt ?? null;
      const rows = await ctx.driver.query<Raw>(
        `SELECT * FROM (
           SELECT le.*, p.reference_no AS reference_no,
             SUM(le.amount) OVER (ORDER BY le.created_at, le.id) AS running_balance
           FROM ledger_entries le LEFT JOIN purchases p ON p.id = le.purchase_id
           WHERE le.supplier_id = ?
         ) WHERE (? IS NULL OR created_at < ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
        [supplierId, before, before, limit],
      );
      const lines = rows.map((r): SupplierLedgerLine => {
        const { running_balance: running, reference_no: referenceNo, ...entry } = r;
        return {
          entry: mapRow<LedgerEntry>(entry),
          runningBalance: paisa(Number(running)),
          referenceNo: typeof referenceNo === 'string' ? referenceNo : null,
        };
      });
      return {
        supplier: supplier as unknown as Supplier,
        balance: paisa(await supplierBalance(ctx.driver, supplierId)),
        lines,
      };
    },

    async totals() {
      requireSession(ctx);
      if (!canDo(ctx, 'receive_stock') && !canDo(ctx, 'view_reports'))
        throw new ServiceError('FORBIDDEN', 'Permission required: receive_stock', {
          permission: 'receive_stock',
        });
      const rows = await ctx.driver.query<{ payable: number; owed: number }>(
        `SELECT COALESCE(SUM(balance), 0) AS payable, COUNT(*) AS owed FROM (
           SELECT supplier_id, SUM(amount) AS balance FROM ledger_entries
           WHERE supplier_id IS NOT NULL GROUP BY supplier_id HAVING SUM(amount) > 0)`,
      );
      return { payable: paisa(rows[0]?.payable ?? 0), suppliersOwed: rows[0]?.owed ?? 0 };
    },
  });
}
