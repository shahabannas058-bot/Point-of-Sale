import {
  PaymentMethodSchema,
  type PartyBalance,
  type Paisa,
  type Purchase,
  type PurchasingApi,
  type Supplier,
} from '@pos/shared';
import { negPaisa, paisa } from '@pos/core';
import { WriteBatch } from './batch';
import { createProductResolver, normalizePhone, stagePhoneUnit } from './catalog';
import { requirePermission, type Ctx } from './deps';
import { guardApi, intIn, invalid, money, optPhone, optText, reqText } from './errors';
import { mapRow, type Raw } from './mappers';
import { loadShop } from './meta';
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
      const referenceNo = optText(i.referenceNo, 'referenceNo', 60);
      const note = optText(i.note, 'note', 500);
      // validate everything up front and compute the total
      let total = 0;
      for (const p of phones) total += normalizePhone(p).costPrice;
      const lines = accessories.map((a, idx) => {
        if (typeof a.variantId !== 'string')
          throw invalid(`accessories.${idx}.variantId`, 'variantId is required');
        const quantity = intIn(a.quantity, `accessories.${idx}.quantity`, 1, 1_000_000);
        const unitCost = money(a.unitCost, `accessories.${idx}.unitCost`);
        total += quantity * unitCost;
        return { variantId: a.variantId, quantity, unitCost };
      });
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
          insertMovement(b, {
            id: ctx.newId(),
            branchId: shop.branchId,
            type: 'purchase',
            phoneUnitId: null,
            variantId: l.variantId,
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
  });
}
