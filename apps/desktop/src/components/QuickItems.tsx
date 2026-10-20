import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Pin, Settings2, X, Zap } from 'lucide-react';
import { MAX_QUICK_ITEMS, type VariantView } from '@pos/shared';
import { useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { perUnit, variantQtyText } from '../lib/qty';
import { useService } from '../service/context';
import { toast } from '../store/toast';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Input } from './ui/Field';
import { Empty, Kbd, Money } from './ui/misc';

/** How many tiles get an Alt+n shortcut. */
export const QUICK_HOTKEYS = 9;

/** One-tap tiles above the bill. Out-of-stock tiles stay visible but cannot be added. */
export function QuickItemsBar({
  items,
  onPick,
  onEdit,
}: {
  items: readonly VariantView[];
  onPick: (item: VariantView) => void;
  /** Shown to users who may change the pins (manage_settings). */
  onEdit?: () => void;
}): ReactNode {
  const t = useT();
  if (items.length === 0)
    return onEdit ? (
      <button
        type="button"
        onClick={onEdit}
        className="flex items-center gap-2 self-start rounded-xl border border-dashed border-line px-3 py-2 text-sm text-muted hover:text-ink"
      >
        <Zap size={16} aria-hidden="true" />
        {t('quick.setup')}
      </button>
    ) : null;
  return (
    <section aria-label={t('quick.title')} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="panel-title flex items-center gap-1.5">
          <Zap size={14} aria-hidden="true" />
          {t('quick.title')}
        </h2>
        {onEdit ? (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Settings2 size={14} aria-hidden="true" />
            {t('quick.edit')}
          </Button>
        ) : null}
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
        {items.map((v, i) => {
          const out = v.onHand <= 0;
          return (
            <li key={v.variant.id} className="min-w-0">
              <button
                type="button"
                disabled={out}
                onClick={() => onPick(v)}
                title={v.label}
                className="card flex h-full w-full min-w-0 flex-col items-start gap-1 p-3 text-start transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex w-full items-start justify-between gap-2">
                  <span className="line-clamp-2 text-sm font-semibold">{v.label}</span>
                  {i < QUICK_HOTKEYS ? <Kbd>{`Alt+${i + 1}`}</Kbd> : null}
                </span>
                <span className="whitespace-nowrap">
                  <Money value={v.variant.salePrice} className="text-sm font-bold" />
                  <span className="ltr text-xs text-muted">
                    {perUnit(v.variant.unitScale, v.variant.unitLabel)}
                  </span>
                </span>
                <Badge tone={out ? 'danger' : v.lowStock ? 'warning' : 'muted'}>
                  {out
                    ? t('billing.outOfStock')
                    : t('inv.onHand', { n: variantQtyText(v.onHand, v.variant) })}
                </Badge>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const move = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const next = [...list];
  const [it] = next.splice(from, 1);
  if (it !== undefined) next.splice(to, 0, it);
  return next;
};

/** Owner picks, orders and removes the pinned items; Save replaces the whole list. */
export function QuickItemsDialog({
  open,
  onClose,
  items,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  items: readonly VariantView[];
  onSaved: (items: VariantView[]) => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const [pinned, setPinned] = useState<VariantView[]>([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<VariantView[]>([]);
  const [busy, setBusy] = useState(false);

  // reset only when the dialog opens: a background refresh of `items` must not wipe unsaved pins
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    if (!open) return;
    setPinned([...itemsRef.current]);
    setQ('');
    setHits([]);
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const id = window.setTimeout(() => {
      service.catalog
        .search(term, { limit: 12 })
        .then((r) => {
          if (live) setHits(r.flatMap((h) => (h.kind === 'variant' ? [h.item] : [])));
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [q, service]);

  const isPinned = (id: string): boolean => pinned.some((p) => p.variant.id === id);
  const pin = (v: VariantView): void => {
    if (isPinned(v.variant.id)) return;
    if (pinned.length >= MAX_QUICK_ITEMS) {
      toast.warning(t('quick.full', { max: String(MAX_QUICK_ITEMS) }));
      return;
    }
    setPinned([...pinned, v]);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const saved = await service.catalog.setQuickItems(pinned.map((p) => p.variant.id));
      toast.success(t('quick.saved'));
      onSaved(saved);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('quick.edit')}
      width={640}
      dismissable={!busy}
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
      <p className="mb-3 text-sm text-muted">{t('quick.hint')}</p>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('quick.search')}
        aria-label={t('quick.search')}
        autoComplete="off"
        data-autofocus
      />
      {q.trim().length >= 2 ? (
        hits.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t('quick.noMatch')}</p>
        ) : (
          <ul className="mt-2 max-h-56 overflow-auto rounded-xl border border-line">
            {hits.map((v) => (
              <li
                key={v.variant.id}
                className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{v.label}</span>
                  <span className="ltr block text-xs text-muted">{v.variant.sku}</span>
                </span>
                <Button
                  size="sm"
                  variant={isPinned(v.variant.id) ? 'ghost' : 'secondary'}
                  disabled={isPinned(v.variant.id)}
                  onClick={() => pin(v)}
                >
                  <Pin size={14} aria-hidden="true" />
                  {t('quick.pin')}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <h3 className="panel-title mt-4 mb-2">
        {t('quick.pinned', { n: String(pinned.length), max: String(MAX_QUICK_ITEMS) })}
      </h3>
      {pinned.length === 0 ? (
        <Empty title={t('quick.none')} />
      ) : (
        <ol className="flex flex-col gap-1">
          {pinned.map((v, i) => (
            <li
              key={v.variant.id}
              className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5"
            >
              <span className="w-6 text-xs text-muted">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{v.label}</span>
              <Button
                icon
                size="sm"
                variant="ghost"
                aria-label={t('quick.moveUp')}
                disabled={i === 0}
                onClick={() => setPinned(move(pinned, i, i - 1))}
              >
                <ArrowUp size={14} aria-hidden="true" />
              </Button>
              <Button
                icon
                size="sm"
                variant="ghost"
                aria-label={t('quick.moveDown')}
                disabled={i === pinned.length - 1}
                onClick={() => setPinned(move(pinned, i, i + 1))}
              >
                <ArrowDown size={14} aria-hidden="true" />
              </Button>
              <Button
                icon
                size="sm"
                variant="ghost"
                aria-label={t('common.remove')}
                onClick={() => setPinned(pinned.filter((p) => p.variant.id !== v.variant.id))}
              >
                <X size={14} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
