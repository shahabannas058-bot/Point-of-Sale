import { useEffect, useState, type ReactNode } from 'react';
import { PackagePlus, Pencil, Plus, Search, SlidersHorizontal } from 'lucide-react';
import {
  PHONE_CONDITIONS,
  PTA_STATUSES,
  type PhoneCondition,
  type PhoneUnitView,
  type PtaStatus,
  type VariantView,
} from '@pos/shared';
import {
  PhoneFields,
  draftFromView,
  draftToInput,
  emptyPhoneDraft,
  type PhoneDraft,
} from '../components/PhoneFields';
import { ConditionBadge, PtaBadge } from '../components/ProductBadges';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input, Select } from '../components/ui/Field';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows, Tabs } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { paisaToInput, parseRupees } from '../lib/money';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { useCan } from '../store/session';
import { toast } from '../store/toast';
import { ReceiveStockDialog } from './ReceiveStockDialog';

type TabKey = 'phones' | 'accessories' | 'low';

// ------------------------------------------------------------------ phone add/edit
function PhoneDialog({
  open,
  unit,
  onClose,
}: {
  open: boolean;
  unit: PhoneUnitView | null;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [draft, setDraft] = useState<PhoneDraft>(emptyPhoneDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setDraft(unit ? draftFromView(unit) : emptyPhoneDraft());
      setError(null);
    }
  }, [open, unit]);

  const save = async (): Promise<void> => {
    const r = draftToInput(draft);
    if ('error' in r) return setError(t(r.error));
    setBusy(true);
    setError(null);
    try {
      if (unit) {
        await service.catalog.updatePhoneUnit(unit.unit.id, {
          salePrice: r.input.salePrice,
          costPrice: r.input.costPrice,
          colour: r.input.colour ?? null,
          note: r.input.note ?? null,
          ptaStatus: r.input.ptaStatus,
          condition: r.input.condition,
          batteryHealthPct: r.input.batteryHealthPct ?? null,
        });
      } else {
        await service.catalog.createPhoneUnit(r.input);
      }
      bump();
      toast.success(t('common.saved'));
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
      width={760}
      dismissable={!busy}
      title={unit ? t('inv.editPhone') : t('inv.addPhone')}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <PhoneFields draft={draft} onChange={setDraft} lockIdentity={unit !== null} />
        <button type="submit" className="sr-only" tabIndex={-1}>
          {t('common.save')}
        </button>
      </form>
      <div role="alert" className="mt-3 min-h-5 text-sm font-medium text-[var(--danger-ink)]">
        {error}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ accessory add/edit
function AccessoryDialog({
  open,
  item,
  onClose,
}: {
  open: boolean;
  item: VariantView | null;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const empty = {
    brand: 'Generic',
    name: '',
    sku: '',
    barcode: '',
    model: '',
    colour: '',
    cost: '',
    price: '',
    reorder: '5',
    opening: '0',
  };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(
      item
        ? {
            brand: item.product.brand,
            name: item.product.name,
            sku: item.variant.sku,
            barcode: item.variant.barcode ?? '',
            model: item.variant.model ?? '',
            colour: item.variant.colour ?? '',
            cost: paisaToInput(item.variant.costPrice),
            price: paisaToInput(item.variant.salePrice),
            reorder: String(item.variant.reorderLevel),
            opening: '0',
          }
        : empty,
    );
  }, [open, item]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  const save = async (): Promise<void> => {
    const cost = parseRupees(f.cost);
    const price = parseRupees(f.price);
    const reorder = Number(f.reorder);
    const opening = Number(f.opening || '0');
    if (!item && (!f.name.trim() || !f.sku.trim())) return setError(t('inv.errProduct'));
    if (cost === null || price === null) return setError(t('inv.errPrice'));
    if (!Number.isInteger(reorder) || reorder < 0 || !Number.isInteger(opening) || opening < 0)
      return setError(t('inv.errQty'));
    setBusy(true);
    setError(null);
    try {
      if (item) {
        await service.catalog.updateVariant(item.variant.id, {
          costPrice: cost,
          salePrice: price,
          barcode: f.barcode.trim() || null,
          reorderLevel: reorder,
          model: f.model.trim() || null,
          colour: f.colour.trim() || null,
        });
      } else {
        await service.catalog.createAccessory({
          product: {
            brand: f.brand.trim() || 'Generic',
            name: f.name.trim(),
            category: 'Accessory',
          },
          sku: f.sku.trim(),
          barcode: f.barcode.trim() || null,
          model: f.model.trim() || null,
          colour: f.colour.trim() || null,
          costPrice: cost,
          salePrice: price,
          reorderLevel: reorder,
          openingQty: opening,
        });
      }
      bump();
      toast.success(t('common.saved'));
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
      width={680}
      dismissable={!busy}
      title={item ? t('inv.editAccessory') : t('inv.addAccessory')}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t('inv.brand')}>
          <Input value={f.brand} onChange={set('brand')} disabled={item !== null} />
        </Field>
        <Field label={t('inv.productName')} className="sm:col-span-2">
          <Input
            value={f.name}
            onChange={set('name')}
            disabled={item !== null}
            data-autofocus={item === null ? true : undefined}
          />
        </Field>
        <Field label="SKU">
          <Input value={f.sku} onChange={set('sku')} className="ltr" disabled={item !== null} />
        </Field>
        <Field label={t('inv.barcode')}>
          <Input value={f.barcode} onChange={set('barcode')} className="ltr" inputMode="numeric" />
        </Field>
        <Field label={t('inv.reorder')}>
          <Input value={f.reorder} onChange={set('reorder')} className="ltr" inputMode="numeric" />
        </Field>
        <Field label={t('inv.forModel')}>
          <Input value={f.model} onChange={set('model')} />
        </Field>
        <Field label={t('inv.colour')}>
          <Input value={f.colour} onChange={set('colour')} />
        </Field>
        {item === null ? (
          <Field label={t('inv.openingQty')}>
            <Input
              value={f.opening}
              onChange={set('opening')}
              className="ltr"
              inputMode="numeric"
            />
          </Field>
        ) : (
          <span />
        )}
        <Field label={t('inv.cost')}>
          <Input value={f.cost} onChange={set('cost')} className="ltr" inputMode="decimal" />
        </Field>
        <Field label={t('inv.price')}>
          <Input value={f.price} onChange={set('price')} className="ltr" inputMode="decimal" />
        </Field>
        <button type="submit" className="sr-only" tabIndex={-1}>
          {t('common.save')}
        </button>
      </form>
      <div role="alert" className="mt-3 min-h-5 text-sm font-medium text-[var(--danger-ink)]">
        {error}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ stock adjustment
function AdjustDialog({
  item,
  onClose,
}: {
  item: VariantView | null;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (item) {
      setDelta('');
      setReason('');
      setError(null);
    }
  }, [item]);
  const d = Number(delta);
  const valid = delta.trim() !== '' && Number.isInteger(d) && d !== 0 && reason.trim().length > 0;

  const save = async (): Promise<void> => {
    if (!item || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await service.catalog.adjustStock({
        variantId: item.variant.id,
        delta: d,
        reason: reason.trim(),
      });
      bump();
      toast.success(t('common.saved'));
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      width={440}
      title={t('inv.adjustStock')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="text-sm">
          <span className="font-semibold">{item?.label}</span> —{' '}
          {t('inv.onHand', { n: item?.onHand ?? 0 })}
        </p>
        <Field label={t('inv.adjustDelta')} hint={t('inv.adjustDeltaHint')}>
          <Input
            value={delta}
            onChange={(e) => setDelta(e.target.value.replace(/[^\d-]/g, ''))}
            inputMode="numeric"
            className="ltr"
            data-autofocus
          />
        </Field>
        <Field label={t('inv.adjustReason')}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div role="alert" className="min-h-5 text-sm font-medium text-[var(--danger-ink)]">
          {error}
        </div>
        <button type="submit" className="sr-only" tabIndex={-1}>
          {t('common.save')}
        </button>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ screen
export function Inventory(): ReactNode {
  const t = useT();
  const can = useCan();
  const [tab, setTab] = useState<TabKey>('phones');
  const [q, setQ] = useState('');
  const [pta, setPta] = useState<PtaStatus | ''>('');
  const [cond, setCond] = useState<PhoneCondition | ''>('');
  const [inStock, setInStock] = useState(true);
  const [phoneEdit, setPhoneEdit] = useState<{ open: boolean; unit: PhoneUnitView | null }>({
    open: false,
    unit: null,
  });
  const [accEdit, setAccEdit] = useState<{ open: boolean; item: VariantView | null }>({
    open: false,
    item: null,
  });
  const [adjust, setAdjust] = useState<VariantView | null>(null);
  const [recvOpen, setRecvOpen] = useState(false);

  const canEdit = can('edit_catalog');
  const showCost = can('view_cost');

  const phones = useServiceQuery(
    (s) =>
      s.catalog.listPhones({
        q: q || undefined,
        ...(pta ? { pta } : {}),
        ...(cond ? { condition: cond } : {}),
        ...(inStock ? { inStock: true } : {}),
      }),
    [q, pta, cond, inStock],
    tab === 'phones',
  );
  const accessories = useServiceQuery(
    (s) => s.catalog.listAccessories({ q: q || undefined, lowStockOnly: tab === 'low' }),
    [q, tab],
    tab !== 'phones',
  );

  return (
    <div>
      <PageHeader
        title={t('nav.inventory')}
        actions={
          <>
            {can('receive_stock') ? (
              <Button variant="primary" onClick={() => setRecvOpen(true)}>
                <PackagePlus size={16} aria-hidden="true" />
                {t('recv.title')}
              </Button>
            ) : null}
            {canEdit ? (
              <>
                <Button onClick={() => setPhoneEdit({ open: true, unit: null })}>
                  <Plus size={16} aria-hidden="true" />
                  {t('inv.addPhone')}
                </Button>
                <Button onClick={() => setAccEdit({ open: true, item: null })}>
                  <Plus size={16} aria-hidden="true" />
                  {t('inv.addAccessory')}
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Tabs
          label={t('nav.inventory')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'phones', label: t('inv.tabPhones') },
            { value: 'accessories', label: t('inv.tabAccessories') },
            { value: 'low', label: t('inv.tabLow') },
          ]}
        />
        <div className="relative min-w-60 flex-1 sm:max-w-sm">
          <Search
            size={16}
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="ps-9"
            placeholder={t('inv.searchPlaceholder')}
            aria-label={t('inv.searchPlaceholder')}
          />
        </div>
        {tab === 'phones' ? (
          <>
            <Select
              className="w-auto"
              value={pta}
              onChange={(e) => setPta(e.target.value as PtaStatus | '')}
              aria-label={t('inv.pta')}
            >
              <option value="">
                {t('inv.pta')}: {t('common.all')}
              </option>
              {PTA_STATUSES.map((p) => (
                <option key={p} value={p}>
                  {t(dynKey('pta', p))}
                </option>
              ))}
            </Select>
            <Select
              className="w-auto"
              value={cond}
              onChange={(e) => setCond(e.target.value as PhoneCondition | '')}
              aria-label={t('inv.condition')}
            >
              <option value="">
                {t('inv.condition')}: {t('common.all')}
              </option>
              {PHONE_CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {t(dynKey('condition', c))}
                </option>
              ))}
            </Select>
            <label className="check">
              <input
                type="checkbox"
                checked={inStock}
                onChange={(e) => setInStock(e.target.checked)}
              />
              {t('inv.inStockOnly')}
            </label>
          </>
        ) : null}
      </div>

      {tab === 'phones' ? (
        phones.error ? (
          <ErrorBox error={phones.error} onRetry={phones.reload} />
        ) : (
          <div className="tbl-wrap">
            {phones.loading && !phones.data ? (
              <SkeletonRows />
            ) : (phones.data ?? []).length === 0 ? (
              <Empty title={t('inv.noPhones')} hint={t('inv.noPhonesHint')} />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('inv.product')}</th>
                    <th>IMEI</th>
                    <th>{t('inv.colour')}</th>
                    <th>{t('inv.pta')}</th>
                    <th>{t('inv.condition')}</th>
                    {showCost ? <th className="num">{t('inv.cost')}</th> : null}
                    <th className="num">{t('inv.price')}</th>
                    <th>{t('inv.status')}</th>
                    {canEdit ? (
                      <th className="w-12">
                        <span className="sr-only">{t('common.edit')}</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {(phones.data ?? []).map((v) => (
                    <tr key={v.unit.id}>
                      <td className="font-semibold">{v.label}</td>
                      <td className="ltr font-mono text-xs">
                        <div>{v.unit.imei1 ?? v.unit.serial}</div>
                        {v.unit.imei2 ? <div className="text-muted">{v.unit.imei2}</div> : null}
                      </td>
                      <td>{v.unit.colour ?? '—'}</td>
                      <td>
                        <PtaBadge status={v.unit.ptaStatus} />
                      </td>
                      <td>
                        <ConditionBadge condition={v.unit.condition} />
                        {v.unit.batteryHealthPct !== null ? (
                          <span className="ms-1 text-xs text-muted">
                            {v.unit.batteryHealthPct}%
                          </span>
                        ) : null}
                      </td>
                      {showCost ? (
                        <td className="num">
                          <Money value={v.unit.costPrice} symbol={null} />
                        </td>
                      ) : null}
                      <td className="num">
                        <Money value={v.unit.salePrice} symbol={null} className="font-semibold" />
                      </td>
                      <td>
                        {v.inStock ? (
                          <Badge tone="success">{t('inv.inStock')}</Badge>
                        ) : (
                          <Badge tone="muted">{t('inv.sold')}</Badge>
                        )}
                      </td>
                      {canEdit ? (
                        <td>
                          <Button
                            variant="ghost"
                            icon
                            size="sm"
                            aria-label={t('common.edit')}
                            onClick={() => setPhoneEdit({ open: true, unit: v })}
                          >
                            <Pencil size={15} aria-hidden="true" />
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      ) : accessories.error ? (
        <ErrorBox error={accessories.error} onRetry={accessories.reload} />
      ) : (
        <div className="tbl-wrap">
          {accessories.loading && !accessories.data ? (
            <SkeletonRows />
          ) : (accessories.data ?? []).length === 0 ? (
            <Empty
              title={tab === 'low' ? t('inv.noLow') : t('inv.noAccessories')}
              hint={tab === 'low' ? t('inv.noLowHint') : t('inv.noPhonesHint')}
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('inv.product')}</th>
                  <th>{t('inv.forModel')}</th>
                  <th>{t('inv.colour')}</th>
                  <th>SKU</th>
                  <th>{t('inv.barcode')}</th>
                  <th className="num">{t('inv.stock')}</th>
                  {showCost ? <th className="num">{t('inv.cost')}</th> : null}
                  <th className="num">{t('inv.price')}</th>
                  {canEdit ? (
                    <th className="w-24">
                      <span className="sr-only">{t('common.edit')}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {(accessories.data ?? []).map((v) => (
                  <tr key={v.variant.id}>
                    <td className="font-semibold">{v.product.name}</td>
                    <td>{v.variant.model ?? '—'}</td>
                    <td>{v.variant.colour ?? '—'}</td>
                    <td className="ltr font-mono text-xs">{v.variant.sku}</td>
                    <td className="ltr font-mono text-xs">{v.variant.barcode ?? '—'}</td>
                    <td className="num">
                      <span className="inline-flex items-center gap-2">
                        {v.lowStock ? <Badge tone="danger">{t('inv.low')}</Badge> : null}
                        <b>{v.onHand}</b>
                      </span>
                    </td>
                    {showCost ? (
                      <td className="num">
                        <Money value={v.variant.costPrice} symbol={null} />
                      </td>
                    ) : null}
                    <td className="num">
                      <Money value={v.variant.salePrice} symbol={null} className="font-semibold" />
                    </td>
                    {canEdit ? (
                      <td>
                        <div className="flex justify-end gap-1">
                          {can('adjust_stock') ? (
                            <Button
                              variant="ghost"
                              icon
                              size="sm"
                              aria-label={t('inv.adjustStock')}
                              onClick={() => setAdjust(v)}
                            >
                              <SlidersHorizontal size={15} aria-hidden="true" />
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            icon
                            size="sm"
                            aria-label={t('common.edit')}
                            onClick={() => setAccEdit({ open: true, item: v })}
                          >
                            <Pencil size={15} aria-hidden="true" />
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <PhoneDialog
        open={phoneEdit.open}
        unit={phoneEdit.unit}
        onClose={() => setPhoneEdit((s) => ({ ...s, open: false }))}
      />
      <AccessoryDialog
        open={accEdit.open}
        item={accEdit.item}
        onClose={() => setAccEdit((s) => ({ ...s, open: false }))}
      />
      <AdjustDialog item={adjust} onClose={() => setAdjust(null)} />
      <ReceiveStockDialog open={recvOpen} onClose={() => setRecvOpen(false)} />
    </div>
  );
}
