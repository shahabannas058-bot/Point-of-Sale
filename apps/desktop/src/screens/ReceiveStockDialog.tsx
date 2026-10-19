import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PackagePlus, Plus, Trash } from 'lucide-react';
import {
  PAYMENT_METHODS,
  lineGross,
  parseQuantity,
  type BatchInput,
  type NewPhoneUnitInput,
  type PaymentMethod,
  type VariantView,
} from '@pos/shared';
import {
  PhoneFields,
  draftToInput,
  emptyPhoneDraft,
  type PhoneDraft,
} from '../components/PhoneFields';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input, Select } from '../components/ui/Field';
import { Money } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { paisaToInput, parseRupees } from '../lib/money';
import { perUnit } from '../lib/qty';
import { useService } from '../service/context';
import { useShopModules } from '../service/use-modules';
import { nicheKey } from '../i18n/niche';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { toast } from '../store/toast';

interface AccRow {
  id: number;
  variantId: string;
  qty: string;
  cost: string;
  /** Module batch_expiry. A date from <input type="date">, so always YYYY-MM-DD or ''. */
  batchNo: string;
  expiry: string;
}

export function ReceiveStockDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const suppliers = useServiceQuery((s) => s.purchasing.listSuppliers(), [], open);
  const accessories = useServiceQuery((s) => s.catalog.listAccessories(), [], open);
  // a shop without the imei module (kiryana) receives only items, never phones
  const shopModules = useShopModules();
  const hasPhones = shopModules.modules === undefined || shopModules.has('imei');
  // perishable goods (kiryana): each line may carry a batch number and an expiry date
  const hasBatches = shopModules.has('batch_expiry');

  const [supplierId, setSupplierId] = useState('');
  const [newSupplier, setNewSupplier] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [phones, setPhones] = useState<{ id: number; draft: PhoneDraft }[]>([]);
  const [accs, setAccs] = useState<AccRow[]>([]);
  const [paid, setPaid] = useState('');
  const [method, setMethod] = useState<Exclude<PaymentMethod, 'khata'>>('cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(1);

  useEffect(() => {
    if (open) {
      setSupplierId('');
      setNewSupplier(null);
      setReference('');
      setPhones([]);
      setAccs([]);
      setPaid('');
      setMethod('cash');
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!supplierId && suppliers.data?.[0]) setSupplierId(suppliers.data[0].party.id);
  }, [suppliers.data, supplierId]);

  const variantById = useMemo(
    () => new Map<string, VariantView>((accessories.data ?? []).map((v) => [v.variant.id, v])),
    [accessories.data],
  );

  const total = useMemo(() => {
    let sum = 0;
    for (const p of phones) sum += parseRupees(p.draft.cost) ?? 0;
    for (const a of accs) {
      const scale = variantById.get(a.variantId)?.variant.unitScale ?? 1;
      sum += lineGross(parseQuantity(a.qty, scale) ?? 0, parseRupees(a.cost) ?? 0, scale);
    }
    return sum;
  }, [phones, accs, variantById]);

  const addSupplier = async (): Promise<void> => {
    if (!newSupplier?.trim()) return;
    try {
      const s = await service.purchasing.createSupplier({ name: newSupplier.trim() });
      bump();
      setSupplierId(s.id);
      setNewSupplier(null);
    } catch (e) {
      setError(errorMessage(e, t));
    }
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (!supplierId) return setError(t('recv.errSupplier'));
    const phoneInputs: NewPhoneUnitInput[] = [];
    for (const p of phones) {
      const r = draftToInput(p.draft);
      if ('error' in r) return setError(t(r.error));
      phoneInputs.push(r.input);
    }
    const accInputs: {
      variantId: string;
      quantity: number;
      unitCost: number;
      batch?: BatchInput | null;
    }[] = [];
    for (const a of accs) {
      const qty = parseQuantity(a.qty, variantById.get(a.variantId)?.variant.unitScale ?? 1);
      const cost = parseRupees(a.cost);
      if (!a.variantId || qty === null || qty <= 0 || cost === null)
        return setError(t(nicheKey(hasPhones, 'recv.errAccessory')));
      if (hasBatches && a.batchNo.trim() !== '' && a.expiry === '')
        return setError(t('recv.errExpiry'));
      accInputs.push({
        variantId: a.variantId,
        quantity: qty,
        unitCost: cost,
        ...(hasBatches && a.expiry !== ''
          ? { batch: { batchNo: a.batchNo.trim() || null, expiryDate: a.expiry } }
          : {}),
      });
    }
    if (phoneInputs.length + accInputs.length === 0)
      return setError(t(nicheKey(hasPhones, 'recv.errEmpty')));
    const paidP = paid.trim() === '' ? 0 : parseRupees(paid);
    if (paidP === null || paidP > total) return setError(t('recv.errPaid'));
    setBusy(true);
    try {
      const r = await service.purchasing.receive({
        supplierId,
        referenceNo: reference.trim() || null,
        phones: phoneInputs,
        accessories: accInputs,
        paidNow: paidP > 0 ? { method, amount: paidP } : null,
      });
      bump();
      toast.success(t('recv.done', { n: phoneInputs.length + accInputs.length }));
      void r;
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={980}
      dismissable={!busy}
      title={
        <span className="flex items-center gap-2">
          <PackagePlus size={20} aria-hidden="true" />
          {t('recv.title')}
        </span>
      }
      footer={
        <>
          <div className="me-auto text-sm">
            {t('recv.total')}: <Money value={total} className="text-lg font-bold" />
          </div>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t('recv.receive')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Field label={t('recv.supplier')}>
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              {(suppliers.data ?? []).map((s) => (
                <option key={s.party.id} value={s.party.id}>
                  {s.party.name}
                </option>
              ))}
            </Select>
          </Field>
          {newSupplier === null ? (
            <button
              type="button"
              className="self-start text-sm font-semibold text-primary-ink"
              onClick={() => setNewSupplier('')}
            >
              + {t('recv.newSupplier')}
            </button>
          ) : (
            <div className="flex gap-2">
              <Input
                value={newSupplier}
                onChange={(e) => setNewSupplier(e.target.value)}
                placeholder={t('recv.supplierName')}
                aria-label={t('recv.supplierName')}
              />
              <Button variant="secondary" onClick={() => void addSupplier()}>
                {t('common.save')}
              </Button>
            </div>
          )}
        </div>
        <Field label={t('recv.reference')}>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} className="ltr" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('recv.paidNow')}>
            <Input
              value={paid}
              onChange={(e) => setPaid(e.target.value)}
              inputMode="decimal"
              className="ltr"
              placeholder="0"
            />
          </Field>
          <Field label={t('pay.method')}>
            <Select
              value={method}
              onChange={(e) => setMethod(e.target.value as Exclude<PaymentMethod, 'khata'>)}
            >
              {PAYMENT_METHODS.filter((m) => m !== 'khata').map((m) => (
                <option key={m} value={m}>
                  {t(dynKey('method', m))}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {hasPhones ? <h3 className="mb-2 mt-5 text-base">{t('recv.phones')}</h3> : null}
      <div className={hasPhones ? 'flex flex-col gap-3' : 'hidden'}>
        {phones.map((p, i) => (
          <div key={p.id} className="relative rounded-xl border border-line bg-surface-2 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-muted">#{i + 1}</span>
              <Button
                variant="ghost"
                icon
                size="sm"
                aria-label={t('common.remove')}
                onClick={() => setPhones((rs) => rs.filter((x) => x.id !== p.id))}
              >
                <Trash size={16} aria-hidden="true" />
              </Button>
            </div>
            <PhoneFields
              compact
              draft={p.draft}
              onChange={(d) =>
                setPhones((rs) => rs.map((x) => (x.id === p.id ? { ...x, draft: d } : x)))
              }
            />
          </div>
        ))}
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            const last = phones.at(-1)?.draft;
            setPhones((rs) => [
              ...rs,
              {
                id: seq,
                draft: last
                  ? {
                      ...emptyPhoneDraft(),
                      brand: last.brand,
                      name: last.name,
                      pta: last.pta,
                      condition: last.condition,
                      cost: last.cost,
                      price: last.price,
                    }
                  : emptyPhoneDraft(),
              },
            ]);
            setSeq((s) => s + 1);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t('recv.addPhone')}
        </Button>
      </div>

      <h3 className="mb-2 mt-5 text-base">
        {hasPhones ? t('recv.accessories') : t('inv.tabItems')}
      </h3>
      <div className="flex flex-col gap-2">
        {accs.map((a) => {
          const picked = variantById.get(a.variantId)?.variant;
          const scale = picked?.unitScale ?? 1;
          return (
            <div key={a.id} className="flex flex-col gap-2">
              <div className="grid grid-cols-[minmax(0,2fr)_110px_150px_44px] items-end gap-2">
                <Field label={t('recv.item')}>
                  <Select
                    value={a.variantId}
                    onChange={(e) => {
                      const v = variantById.get(e.target.value);
                      setAccs((rs) =>
                        rs.map((x) =>
                          x.id === a.id
                            ? {
                                ...x,
                                variantId: e.target.value,
                                cost: v ? paisaToInput(v.variant.costPrice) : x.cost,
                              }
                            : x,
                        ),
                      );
                    }}
                  >
                    <option value="">—</option>
                    {(accessories.data ?? []).map((v) => (
                      <option key={v.variant.id} value={v.variant.id}>
                        {v.label} · {v.variant.sku}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label={
                    scale === 1
                      ? t('billing.qty')
                      : t('inv.qtyIn', { unit: picked?.unitLabel ?? '' })
                  }
                >
                  <Input
                    value={a.qty}
                    onChange={(e) =>
                      setAccs((rs) =>
                        rs.map((x) =>
                          x.id === a.id
                            ? {
                                ...x,
                                qty: e.target.value.replace(scale === 1 ? /\D/g : /[^\d.]/g, ''),
                              }
                            : x,
                        ),
                      )
                    }
                    inputMode={scale === 1 ? 'numeric' : 'decimal'}
                    className="ltr"
                  />
                </Field>
                <Field
                  label={`${t('recv.unitCost')}${picked ? ` ${perUnit(picked.unitScale, picked.unitLabel)}` : ''}`}
                >
                  <Input
                    value={a.cost}
                    onChange={(e) =>
                      setAccs((rs) =>
                        rs.map((x) => (x.id === a.id ? { ...x, cost: e.target.value } : x)),
                      )
                    }
                    inputMode="decimal"
                    className="ltr"
                  />
                </Field>
                <Button
                  variant="ghost"
                  icon
                  aria-label={t('common.remove')}
                  onClick={() => setAccs((rs) => rs.filter((x) => x.id !== a.id))}
                >
                  <Trash size={16} aria-hidden="true" />
                </Button>
              </div>
              {hasBatches ? (
                <div className="grid grid-cols-2 gap-2 sm:max-w-md">
                  <Field label={t('recv.batchNo')}>
                    <Input
                      value={a.batchNo}
                      onChange={(e) =>
                        setAccs((rs) =>
                          rs.map((x) => (x.id === a.id ? { ...x, batchNo: e.target.value } : x)),
                        )
                      }
                      maxLength={60}
                      className="ltr"
                    />
                  </Field>
                  <Field label={t('recv.expiry')}>
                    <Input
                      type="date"
                      value={a.expiry}
                      onChange={(e) =>
                        setAccs((rs) =>
                          rs.map((x) => (x.id === a.id ? { ...x, expiry: e.target.value } : x)),
                        )
                      }
                      className="ltr"
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          );
        })}
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            setAccs((rs) => [
              ...rs,
              { id: seq, variantId: '', qty: '1', cost: '', batchNo: '', expiry: '' },
            ]);
            setSeq((s) => s + 1);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(nicheKey(hasPhones, 'recv.addAccessory'))}
        </Button>
      </div>

      <div role="alert" className="mt-3 min-h-5 text-sm font-medium text-[var(--danger-ink)]">
        {error}
      </div>
    </Dialog>
  );
}
