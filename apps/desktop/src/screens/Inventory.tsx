import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  History,
  PackagePlus,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import {
  formatQuantity,
  parseQuantity,
  unitScaleFor,
  type UnitLabel,
  type ItemView,
} from '@pos/shared';
import { ItemHistoryDialog, type ItemHistoryDialogProps } from '../components/ItemHistoryDialog';
import { StockImportDialog } from '../components/StockImportDialog';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input, Select } from '../components/ui/Field';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows, Tabs } from '../components/ui/misc';
import { useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { paisaToInput, parseRupees } from '../lib/money';
import { useBusyAction } from '../lib/busy-action';
import { adjustmentDelta, perUnit, qtyWithUnit, unitWord, itemQtyText } from '../lib/qty';
import { useService } from '../service/context';
import { useShopModules } from '../service/use-modules';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { useCan } from '../store/session';
import { toast } from '../store/toast';
import { ReorderPanel } from '../components/ReorderPanel';
import { ReceiveStockDialog } from './ReceiveStockDialog';

type TabKey = 'items' | 'low' | 'reorder';

// ------------------------------------------------------------------ item add/edit
function ItemDialog({
  open,
  item,
  onClose,
}: {
  open: boolean;
  item: ItemView | null;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const { has } = useShopModules();
  const empty = {
    brand: 'Generic',
    name: '',
    sku: '',
    barcode: '',
    cost: '',
    price: '',
    reorder: '5',
    opening: '0',
    unit: 'pcs' as UnitLabel,
  };
  const [f, setF] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(
      item
        ? {
            brand: item.product.brand,
            name: item.product.name,
            sku: item.item.sku,
            barcode: item.item.barcode ?? '',
            cost: paisaToInput(item.item.costPrice),
            price: paisaToInput(item.item.salePrice),
            reorder: formatQuantity(item.item.reorderLevel, item.item.unitScale),
            opening: '0',
            unit: item.item.unitLabel,
          }
        : empty,
    );
  }, [open, item]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((s) => ({ ...s, [k]: e.target.value }));
  // an existing item keeps its unit for ever (the database refuses a change once stock exists)
  const unit: UnitLabel = item ? item.item.unitLabel : f.unit;
  const scale = unitScaleFor(unit);

  const { busy, run: save } = useBusyAction(async (): Promise<void> => {
    const cost = parseRupees(f.cost);
    const price = parseRupees(f.price);
    const reorder = parseQuantity(f.reorder.trim() === '' ? '0' : f.reorder, scale);
    const opening = parseQuantity(f.opening.trim() === '' ? '0' : f.opening, scale);
    if (!item && (!f.name.trim() || !f.sku.trim())) return setError(t('inv.errProduct'));
    if (cost === null || price === null) return setError(t('inv.errPrice'));
    if (reorder === null || opening === null)
      return setError(t(scale === 1 ? 'inv.errQty' : 'inv.errQtyUnit'));
    setError(null);
    try {
      if (item) {
        await service.catalog.updateItem(item.item.id, {
          costPrice: cost,
          salePrice: price,
          barcode: f.barcode.trim() || null,
          reorderLevel: reorder,
        });
      } else {
        await service.catalog.createItem({
          product: {
            brand: f.brand.trim() || 'Generic',
            name: f.name.trim(),
            category: null,
          },
          sku: f.sku.trim(),
          barcode: f.barcode.trim() || null,
          costPrice: cost,
          salePrice: price,
          reorderLevel: reorder,
          openingQty: opening,
          unit,
        });
      }
      bump();
      toast.success(t('common.saved'));
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    }
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={680}
      dismissable={!busy}
      title={item ? t('inv.editItem') : t('inv.addItem')}
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
        <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-3">
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
            <Input
              value={f.barcode}
              onChange={set('barcode')}
              className="ltr"
              inputMode="numeric"
            />
          </Field>
          {item === null && has('weight_units') ? (
            <Field label={t('inv.soldBy')}>
              <Select
                value={f.unit}
                onChange={(e) => setF((s) => ({ ...s, unit: e.target.value as UnitLabel }))}
              >
                <option value="pcs">{t('inv.unitPcs')}</option>
                <option value="kg">{t('inv.unitKg')}</option>
                <option value="L">{t('inv.unitL')}</option>
              </Select>
            </Field>
          ) : null}
          <Field label={scale === 1 ? t('inv.reorder') : `${t('inv.reorder')} (${unit})`}>
            <Input
              value={f.reorder}
              onChange={set('reorder')}
              className="ltr"
              inputMode={scale === 1 ? 'numeric' : 'decimal'}
            />
          </Field>
          {item === null ? (
            <Field label={scale === 1 ? t('inv.openingQty') : `${t('inv.openingQty')} (${unit})`}>
              <Input
                value={f.opening}
                onChange={set('opening')}
                className="ltr"
                inputMode={scale === 1 ? 'numeric' : 'decimal'}
              />
            </Field>
          ) : (
            <span />
          )}
          <Field
            label={t('inv.cost')}
            hint={scale === 1 ? undefined : t('inv.perUnitHint', { unit })}
          >
            <Input value={f.cost} onChange={set('cost')} className="ltr" inputMode="decimal" />
          </Field>
          <Field
            label={t('inv.price')}
            hint={scale === 1 ? undefined : t('inv.perUnitHint', { unit })}
          >
            <Input value={f.price} onChange={set('price')} className="ltr" inputMode="decimal" />
          </Field>
          <button type="submit" className="sr-only" tabIndex={-1}>
            {t('common.save')}
          </button>
        </fieldset>
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
  item: ItemView | null;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (item) {
      setMode('add');
      setAmount('');
      setReason('');
      setError(null);
    }
  }, [item]);
  const scale = item?.item.unitScale ?? 1;
  const unit = item?.item.unitLabel ?? 'pcs';
  const piece = t('unit.piece');
  const d = adjustmentDelta(mode, amount, scale);
  const after = item !== null && d !== null ? item.onHand + d : null;
  const valid = d !== null;

  const { busy, run: save } = useBusyAction(async (): Promise<void> => {
    if (!item || !valid || d === null) return;
    setError(null);
    try {
      await service.catalog.adjustStock({
        itemId: item.item.id,
        delta: d,
        // the reason is optional for the cashier; the stock history always gets one
        reason: reason.trim() || t(mode === 'add' ? 'inv.reasonAdded' : 'inv.reasonRemoved'),
      });
      bump();
      toast.success(t('common.saved'));
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    }
  });

  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      width={440}
      dismissable={!busy}
      title={t('inv.adjustStock')}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={() => void save()}>
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
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
          <p className="text-sm">
            <span className="font-semibold">{item?.label}</span>
            <br />
            {t('inv.adjustNow', {
              n: item ? qtyWithUnit(item.onHand, scale, unit, piece) : 0,
            })}
          </p>
          <Tabs<'add' | 'remove'>
            label={t('inv.adjustStock')}
            value={mode}
            onChange={setMode}
            items={[
              { value: 'add', label: t('inv.adjustAdd') },
              { value: 'remove', label: t('inv.adjustRemove') },
            ]}
          />
          <Field
            label={t('inv.adjustAmount')}
            hint={t(scale === 1 ? 'inv.adjustHintPcs' : 'inv.adjustHintDecimal')}
          >
            <div className="relative">
              <Input
                value={amount}
                onChange={(e) =>
                  setAmount(e.target.value.replace(scale === 1 ? /\D/g : /[^\d.]/g, ''))
                }
                inputMode={scale === 1 ? 'numeric' : 'decimal'}
                placeholder="1"
                className="ltr pe-20 text-lg"
                data-autofocus
              />
              <span className="pointer-events-none absolute end-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted">
                {unitWord(unit, piece)}
              </span>
            </div>
          </Field>
          {after !== null ? (
            after < 0 ? (
              <p className="text-sm font-semibold text-[var(--danger-ink)]">
                {t('inv.adjustTooMuch')}
              </p>
            ) : (
              <p className="text-sm font-semibold">
                {t('inv.adjustNew', { n: qtyWithUnit(after, scale, unit, piece) })}
              </p>
            )
          ) : null}
          <Field label={t('inv.adjustReasonOptional')}>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('inv.adjustReasonPlaceholder')}
            />
          </Field>
          <div role="alert" className="min-h-5 text-sm font-medium text-[var(--danger-ink)]">
            {error}
          </div>
          <button type="submit" className="sr-only" tabIndex={-1}>
            {t('common.save')}
          </button>
        </fieldset>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ screen
export function Inventory(): ReactNode {
  const t = useT();
  const can = useCan();
  const [tab, setTab] = useState<TabKey>('items');
  const [q, setQ] = useState('');
  const [itemEdit, setItemEdit] = useState<{ open: boolean; item: ItemView | null }>({
    open: false,
    item: null,
  });
  const [adjust, setAdjust] = useState<ItemView | null>(null);
  const [recvOpen, setRecvOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [history, setHistory] = useState<Pick<
    ItemHistoryDialogProps,
    'item' | 'label' | 'unitScale' | 'unitLabel'
  > | null>(null);

  const canEdit = can('edit_catalog');
  const showCost = can('view_cost');
  const items = useServiceQuery(
    (s) => s.catalog.listItems({ q: q || undefined, lowStockOnly: tab === 'low' }),
    [q, tab],
    tab === 'items' || tab === 'low',
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
                <Button onClick={() => setItemEdit({ open: true, item: null })}>
                  <Plus size={16} aria-hidden="true" />
                  {t('inv.addItem')}
                </Button>
                <Button onClick={() => setImportOpen(true)}>
                  <Upload size={16} aria-hidden="true" />
                  {t('import.title')}
                </Button>
              </>
            ) : null}
            {can('view_reports') ? (
              <Link to="/inventory/adjustments" className="btn btn-secondary">
                <History size={16} aria-hidden="true" />
                {t('adjlog.open')}
              </Link>
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
            { value: 'items' as const, label: t('inv.tabItems') },
            { value: 'low' as const, label: t('inv.tabLow') },
            { value: 'reorder' as const, label: t('inv.tabReorder') },
          ]}
        />
        <div
          className={`relative min-w-60 flex-1 sm:max-w-sm ${tab === 'reorder' ? 'hidden' : ''}`}
        >
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
      </div>

      {tab === 'reorder' ? (
        <ReorderPanel />
      ) : items.error ? (
        <ErrorBox error={items.error} onRetry={items.reload} />
      ) : (
        <div className="tbl-wrap">
          {items.loading && !items.data ? (
            <SkeletonRows />
          ) : (items.data ?? []).length === 0 ? (
            <Empty
              title={tab === 'low' ? t('inv.noLow') : t('inv.noItems')}
              hint={tab === 'low' ? t('inv.noLowHint') : t('inv.noItemsHint')}
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('inv.product')}</th>
                  <th>SKU</th>
                  <th>{t('inv.barcode')}</th>
                  <th className="num">{t('inv.stock')}</th>
                  {showCost ? <th className="num">{t('inv.cost')}</th> : null}
                  <th className="num">{t('inv.price')}</th>
                  <th className="w-32">
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(items.data ?? []).map((v) => (
                  <tr key={v.item.id}>
                    <td className="font-semibold">
                      {v.product.brand} {v.product.name}
                    </td>
                    <td className="ltr font-mono text-xs">{v.item.sku}</td>
                    <td className="ltr font-mono text-xs">{v.item.barcode ?? '—'}</td>
                    <td className="num">
                      <span className="inline-flex items-center gap-2">
                        {v.lowStock ? <Badge tone="danger">{t('inv.low')}</Badge> : null}
                        <b>{itemQtyText(v.onHand, v.item)}</b>
                      </span>
                    </td>
                    {showCost ? (
                      <td className="num">
                        <Money value={v.item.costPrice} symbol={null} />
                      </td>
                    ) : null}
                    <td className="num">
                      <Money value={v.item.salePrice} symbol={null} className="font-semibold" />
                      <span className="ltr text-xs text-muted">
                        {perUnit(v.item.unitScale, v.item.unitLabel)}
                      </span>
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          icon
                          size="sm"
                          aria-label={t('hist.open')}
                          onClick={() =>
                            setHistory({
                              item: { itemId: v.item.id },
                              label: v.label,
                              unitScale: v.item.unitScale,
                              unitLabel: v.item.unitLabel,
                            })
                          }
                        >
                          <History size={15} aria-hidden="true" />
                        </Button>
                        {canEdit && can('adjust_stock') ? (
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
                        {canEdit ? (
                          <Button
                            variant="ghost"
                            icon
                            size="sm"
                            aria-label={t('common.edit')}
                            onClick={() => setItemEdit({ open: true, item: v })}
                          >
                            <Pencil size={15} aria-hidden="true" />
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <ItemDialog
        open={itemEdit.open}
        item={itemEdit.item}
        onClose={() => setItemEdit((s) => ({ ...s, open: false }))}
      />
      <AdjustDialog item={adjust} onClose={() => setAdjust(null)} />
      <ReceiveStockDialog open={recvOpen} onClose={() => setRecvOpen(false)} />
      <StockImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <ItemHistoryDialog
        item={history?.item ?? null}
        label={history?.label ?? ''}
        unitScale={history?.unitScale ?? 1}
        unitLabel={history?.unitLabel ?? 'pcs'}
        open={history !== null}
        onClose={() => setHistory(null)}
      />
    </div>
  );
}
