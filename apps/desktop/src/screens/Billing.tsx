import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Minus,
  CirclePause,
  Percent,
  Plus,
  ScanBarcode,
  ShoppingCart,
  Trash,
  UserRound,
  X,
} from 'lucide-react';
import {
  formatQuantity,
  isServiceError,
  parseQuantity,
  type ApprovalReason,
  type CartPreview,
  type CatalogHit,
  type PaymentInput,
  type PhoneUnitView,
} from '@pos/shared';
import { ApprovalDialog } from '../components/ApprovalDialog';
import { CustomerPicker } from '../components/CustomerPicker';
import { ImeiPicker } from '../components/ImeiPicker';
import { PaymentPanel } from '../components/PaymentPanel';
import { ConditionBadge, PtaBadge } from '../components/ProductBadges';
import { ReceiptDialog } from '../components/ReceiptDialog';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input } from '../components/ui/Field';
import { Empty, Kbd, Money } from '../components/ui/misc';
import { useT, type TKey } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { formatRs, paisaToInput, parseRupees, percentDiscount } from '../lib/money';
import { printReceipt } from '../lib/print';
import { loadReceiptModel } from '../lib/receipt-model';
import { useHotkeys } from '../lib/shortcuts';
import { useService } from '../service/context';
import {
  cartToDraft,
  lineGrossOf,
  lineScale,
  useCart,
  type AddResult,
  type CartLine,
} from '../store/cart';
import { useDataVersion } from '../store/data-version';
import { toast } from '../store/toast';
import { formatTime } from '../lib/dates';
import {
  QUICK_AMOUNTS,
  perUnit,
  qtyStep,
  qtyText,
  quickLabel,
  variantQtyText,
  weightForAmount,
} from '../lib/qty';

// ---------------------------------------------------------------- line discount cell
function DiscountCell({ line }: { line: CartLine }): ReactNode {
  const t = useT();
  const setLineDiscount = useCart((s) => s.setLineDiscount);
  const [mode, setMode] = useState<'rs' | 'pct'>('rs');
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const gross = lineGrossOf(line);
  const shown = draft ?? (line.discount > 0 ? paisaToInput(line.discount) : '');

  const commit = (): void => {
    if (draft === null) return;
    const txt = draft.trim();
    if (txt === '') {
      setLineDiscount(line.key, 0);
      setBad(false);
    } else {
      const value = mode === 'rs' ? parseRupees(txt) : percentDiscount(gross as never, txt);
      if (value === null || value > gross) {
        setBad(true);
        setDraft(null);
        return;
      }
      setLineDiscount(line.key, value);
      setBad(false);
    }
    setDraft(null);
  };

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="kbd cursor-pointer"
        aria-label={t('billing.discountMode')}
        title={t('billing.discountMode')}
        onClick={() => {
          setMode((m) => (m === 'rs' ? 'pct' : 'rs'));
          setDraft(null);
        }}
      >
        {mode === 'rs' ? 'Rs' : '%'}
      </button>
      <Input
        value={shown}
        inputMode="decimal"
        aria-label={t('billing.lineDiscount')}
        invalid={bad}
        className="input-sm ltr w-24 text-end"
        placeholder="0"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}

/** "12.5 kg" for the stock limit shown when a quantity is capped; undefined when the line has no limit. */
const maxTextOf = (l: CartLine): string | undefined =>
  l.maxQty === null ? undefined : qtyText(l.maxQty, lineScale(l), l.unitLabel);

// ---------------------------------------------------------------- weight cell (loose goods)
function WeightCell({
  line,
  onResult,
}: {
  line: CartLine;
  onResult: (r: AddResult, maxText?: string) => void;
}): ReactNode {
  const t = useT();
  const setQty = useCart((s) => s.setQty);
  const scale = lineScale(line);
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const shown = draft ?? formatQuantity(line.qty, scale);

  // The rupee box: the cashier types what the customer pays and the weight fills in (Rs 100 at Rs 150/kg -> 667 g).
  // The few paisa that rounding the weight to a gram adds are taken off as a line discount, so the line total is
  // exactly what was typed. When not being typed in, the box shows the line total, so it always agrees with the weight.
  const setLineDiscount = useCart((s) => s.setLineDiscount);
  const [amountDraft, setAmountDraft] = useState<string | null>(null);
  const [amountBad, setAmountBad] = useState(false);
  const lastResult = useRef<AddResult>('added');
  const roundOff = useRef(0); // the discount the rupee box itself set, so a later weight change can take it back
  const amountShown = amountDraft ?? paisaToInput(Math.max(0, lineGrossOf(line) - line.discount));

  /** The weight is being changed some other way: the round-off that belonged to the old typed amount goes. */
  const dropRoundOff = (): void => {
    if (roundOff.current > 0 && line.discount === roundOff.current) setLineDiscount(line.key, 0);
    roundOff.current = 0;
  };

  const typeAmount = (text: string): void => {
    setAmountDraft(text);
    if (text.trim() === '') {
      setAmountBad(false);
      return;
    }
    const paisa = parseRupees(text);
    const w = paisa === null ? null : weightForAmount(paisa, line.unitPrice, scale);
    setAmountBad(w === null);
    if (w === null) return;
    setDraft(null);
    setBad(false);
    const result = setQty(line.key, w.quantity);
    lastResult.current = result;
    // held back at the stock limit: the typed amount cannot be met, so there is nothing to round off
    const discount = result === 'capped' ? 0 : w.discount;
    setLineDiscount(line.key, discount);
    roundOff.current = discount;
  };
  const finishAmount = (): void => {
    setAmountDraft(null);
    setAmountBad(false);
    // the weight was held back at the stock limit while typing: say so once, when the cashier is done
    if (lastResult.current === 'capped') onResult('capped', maxTextOf(line));
    lastResult.current = 'added';
  };

  const commit = (): void => {
    if (draft === null) return;
    const q = parseQuantity(draft, scale);
    setDraft(null);
    if (q === null || q <= 0) {
      setBad(true);
      return;
    }
    setBad(false);
    dropRoundOff();
    onResult(setQty(line.key, q), maxTextOf(line));
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-1">
        <Input
          value={shown}
          inputMode="decimal"
          aria-label={t('billing.weight', { unit: line.unitLabel })}
          title={bad ? t('billing.weightInvalid') : undefined}
          invalid={bad}
          className="input-sm ltr w-20 text-end"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        <span className="ltr text-xs font-semibold text-muted">{line.unitLabel}</span>
      </div>
      <div className="flex items-center gap-1">
        <Input
          value={amountShown}
          inputMode="decimal"
          aria-label={t('billing.weightAmount')}
          title={amountBad ? t('billing.amountInvalid') : t('billing.weightAmount')}
          invalid={amountBad}
          className="input-sm ltr w-20 text-end"
          onChange={(e) => typeAmount(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={finishAmount}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        <span className="ltr text-xs font-semibold text-muted">Rs</span>
      </div>
      <div className="flex gap-1">
        {QUICK_AMOUNTS.map((a) => (
          <button
            key={a}
            type="button"
            className="kbd cursor-pointer"
            onClick={() => {
              setDraft(null);
              setBad(false);
              dropRoundOff();
              onResult(setQty(line.key, a), maxTextOf(line));
            }}
          >
            {quickLabel(a, line.unitLabel)}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- invoice discount dialog
function InvoiceDiscountDialog({
  open,
  subtotal,
  current,
  onClose,
  onApply,
}: {
  open: boolean;
  subtotal: number;
  current: number;
  onClose: () => void;
  onApply: (paisa: number) => void;
}): ReactNode {
  const t = useT();
  const [mode, setMode] = useState<'rs' | 'pct'>('rs');
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) {
      setText(current > 0 ? paisaToInput(current) : '');
      setMode('rs');
    }
  }, [open, current]);
  const value =
    text.trim() === ''
      ? 0
      : mode === 'rs'
        ? parseRupees(text)
        : percentDiscount(subtotal as never, text);
  const invalid = value === null || value > subtotal;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={420}
      title={t('billing.invoiceDiscount')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={invalid} onClick={() => onApply(value ?? 0)}>
            {t('common.apply')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) onApply(value ?? 0);
        }}
      >
        <div className="seg self-start" role="group" aria-label={t('billing.discountMode')}>
          <button type="button" aria-pressed={mode === 'rs'} onClick={() => setMode('rs')}>
            Rs
          </button>
          <button type="button" aria-pressed={mode === 'pct'} onClick={() => setMode('pct')}>
            %
          </button>
        </div>
        <Field
          label={mode === 'rs' ? t('billing.discountAmount') : t('billing.discountPercent')}
          error={invalid ? t('billing.discountInvalid') : null}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            inputMode="decimal"
            className="ltr"
            data-autofocus
            invalid={invalid}
          />
        </Field>
        <p className="text-sm text-muted">
          {t('billing.subtotal')}: <Money value={subtotal} />
          {value !== null && value > 0 && !invalid ? (
            <>
              {' → '}
              <Money value={subtotal - value} className="font-semibold" />
            </>
          ) : null}
        </p>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- main screen
const REASON_FALLBACK: ApprovalReason = 'discount';

export function Billing(): ReactNode {
  const t = useT();
  const service = useService();
  const cart = useCart();
  const bump = useDataVersion((s) => s.bump);
  const version = useDataVersion((s) => s.version);

  const searchRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [dropOpen, setDropOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [imeiUnits, setImeiUnits] = useState<PhoneUnitView[] | null>(null);

  const [customerOpen, setCustomerOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [approval, setApproval] = useState<{
    reason: ApprovalReason;
    then: 'pay' | 'retry';
  } | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [lastInvoiceId, setLastInvoiceId] = useState<string | null>(null);
  const pendingPayments = useRef<PaymentInput[] | null>(null);

  const focusSearch = useCallback(() => searchRef.current?.focus(), []);
  useEffect(focusSearch, [focusSearch]);

  // ---- live preview (debounced) ----
  const draft = useMemo(
    () =>
      cartToDraft({
        lines: cart.lines,
        customer: cart.customer,
        invoiceDiscount: cart.invoiceDiscount,
        note: cart.note,
      }),
    [cart.lines, cart.customer, cart.invoiceDiscount, cart.note],
  );
  const [pv, setPv] = useState<{ data: CartPreview | null; error: unknown }>({
    data: null,
    error: null,
  });
  useEffect(() => {
    if (draft.lines.length === 0) {
      setPv({ data: null, error: null });
      return;
    }
    let live = true;
    const id = window.setTimeout(() => {
      service.checkout
        .preview(draft)
        .then((data) => live && setPv({ data, error: null }))
        .catch((error: unknown) => live && setPv({ data: null, error }));
    }, 100);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [draft, service, version]);

  const preview = pv.data;
  const needsApproval = preview?.needsApproval ?? [];
  const approved = cart.approvalToken !== null;

  // ---- adding items ----
  const report = useCallback(
    (r: AddResult, maxText?: string): void => {
      if (r === 'duplicate') toast.warning(t('billing.alreadyInCart'));
      else if (r === 'weighed') toast.info(t('billing.alreadyWeighed'));
      else if (r === 'capped') toast.warning(t('billing.cappedStock', { n: maxText ?? '' }));
      else if (r === 'out') toast.error(t('billing.outOfStock'));
    },
    [t],
  );
  const addHit = useCallback(
    (h: CatalogHit): void => {
      if (h.kind === 'phone_unit') report(useCart.getState().addPhone(h.item));
      else
        report(
          useCart.getState().addVariant(h.item),
          variantQtyText(h.item.onHand, h.item.variant),
        );
      setQ('');
      setHits([]);
      setDropOpen(false);
      setActive(-1);
      focusSearch();
    },
    [report, focusSearch],
  );

  // type-ahead results
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setDropOpen(false);
      return;
    }
    let live = true;
    const id = window.setTimeout(() => {
      service.catalog
        .search(term, { inStockOnly: true, limit: 12 })
        .then((r) => {
          if (!live) return;
          setHits(r);
          setDropOpen(r.length > 0);
          setActive(-1);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [q, service, version]);

  const submitSearch = async (): Promise<void> => {
    const term = q.trim();
    if (!term) return;
    if (dropOpen && active >= 0 && hits[active]) {
      addHit(hits[active]);
      return;
    }
    try {
      const res = await service.catalog.search(term, { inStockOnly: true, limit: 12 });
      const exact = res.filter((h) => h.matchedBy !== 'name');
      const single = exact.length === 1 ? exact[0] : res.length === 1 ? res[0] : undefined;
      if (single) return addHit(single);
      if (res.length === 0) return toast.error(t('billing.notFound', { q: term }));
      const phones = res.filter(
        (h): h is Extract<CatalogHit, { kind: 'phone_unit' }> => h.kind === 'phone_unit',
      );
      if (
        phones.length === res.length &&
        new Set(phones.map((p) => p.item.product.id)).size === 1
      ) {
        setImeiUnits(phones.map((p) => p.item));
        return;
      }
      setHits(res);
      setDropOpen(true);
      setActive(0);
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };

  // ---- checkout ----
  const total = preview?.total ?? 0;
  const startPay = (): void => {
    if (!preview || pv.error) return;
    const reason = needsApproval[0];
    if (reason && !approved) {
      setApproval({ reason, then: 'pay' });
      return;
    }
    setPayError(null);
    setPayOpen(true);
  };

  const doCommit = async (payments: PaymentInput[], token: string | null): Promise<void> => {
    setPayBusy(true);
    setPayError(null);
    try {
      const inv = await service.checkout.commit({
        ...draft,
        payments,
        // one id per cart attempt (store): a retry after a timeout replays the same invoice
        saleId: useCart.getState().saleId,
        ...(token ? { approvalToken: token } : {}),
      });
      toast.success(t('billing.saleDone', { no: inv.invoiceNo }));
      useCart.getState().clear(); // also rotates saleId for the next sale
      setPayOpen(false);
      setLastInvoiceId(inv.id);
      setReceiptId(inv.id);
      bump();
    } catch (e) {
      if (isServiceError(e) && e.code === 'APPROVAL_REQUIRED') {
        const reason = (e.details.reason as ApprovalReason | undefined) ?? REASON_FALLBACK;
        pendingPayments.current = payments;
        setApproval({ reason, then: 'retry' });
      } else {
        if (isServiceError(e) && e.code === 'APPROVAL_INVALID')
          useCart.getState().setApproval(null);
        // SALE_ID_REUSED keeps the id on purpose: Pay stays refused until the cashier clears the bill
        setPayError(errorMessage(e, t));
      }
    } finally {
      setPayBusy(false);
    }
  };

  const onGranted = (token: string): void => {
    const ctx = approval;
    setApproval(null);
    cart.setApproval(token);
    if (ctx?.then === 'pay') {
      setPayError(null);
      setPayOpen(true);
    } else if (ctx?.then === 'retry' && pendingPayments.current) {
      void doCommit(pendingPayments.current, token);
    }
  };

  // ---- hotkeys ----
  // every screen shortcut is blocked while a dialog is open (useHotkeys option below)
  const lines = cart.lines;
  const selectedLine = lines[cart.selected];
  useHotkeys(
    {
      F1: () => setHelpOpen(true),
      F2: () => focusSearch(),
      F4: () => setCustomerOpen(true),
      F7: () => {
        if (lines.length > 0) {
          cart.hold(total);
          toast.info(t('billing.held'));
          focusSearch();
        }
      },
      F8: () => setHeldOpen(true),
      F9: () => startPay(),
      'Ctrl+D': () => {
        if (lines.length > 0) setDiscountOpen(true);
      },
      'Ctrl+P': () => {
        if (lastInvoiceId)
          void loadReceiptModel(service, lastInvoiceId)
            .then(printReceipt)
            .catch((e: unknown) => toast.error(errorMessage(e, t)));
      },
      Escape: () => {
        if (dropOpen) setDropOpen(false);
        else if (q) setQ('');
        else if (lines.length > 0) setClearOpen(true);
      },
      Delete: () => {
        if (selectedLine) cart.remove(selectedLine.key);
      },
      ArrowUp: (e) => {
        if (dropOpen) return;
        e.preventDefault();
        cart.select(Math.max(0, cart.selected - 1));
      },
      ArrowDown: (e) => {
        if (dropOpen) return;
        e.preventDefault();
        cart.select(Math.min(lines.length - 1, cart.selected + 1));
      },
      '+': () => {
        if (selectedLine)
          report(
            cart.setQty(selectedLine.key, selectedLine.qty + qtyStep(lineScale(selectedLine))),
            maxTextOf(selectedLine),
          );
      },
      '-': () => {
        if (selectedLine) {
          const step = qtyStep(lineScale(selectedLine));
          cart.setQty(selectedLine.key, Math.max(step, selectedLine.qty - step));
        }
      },
    },
    true,
    { blockWhileDialogOpen: true },
  );

  const shortcutRows: [string, TKey][] = [
    ['F1', 'sc.help'],
    ['F2', 'sc.search'],
    ['F4', 'sc.customer'],
    ['F7', 'sc.hold'],
    ['F8', 'sc.resume'],
    ['F9', 'sc.pay'],
    ['Ctrl+Enter', 'sc.commit'],
    ['Ctrl+D', 'sc.discount'],
    ['Ctrl+P', 'sc.print'],
    ['Esc', 'sc.escape'],
    ['Del', 'sc.remove'],
    ['↑ ↓', 'sc.select'],
    ['+ / -', 'sc.qty'],
  ];

  const lineTotalOf = (i: number, l: CartLine): number =>
    preview?.lines[i]?.lineTotal ?? lineGrossOf(l) - l.discount;
  const gross = preview?.grossTotal ?? lines.reduce((a, l) => a + lineGrossOf(l), 0);

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
      {/* ------------------------------------------------ left: search + cart */}
      <section className="flex min-w-0 flex-col gap-4" aria-label={t('nav.billing')}>
        <div className="relative">
          <ScanBarcode
            size={22}
            className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            className="input h-14 ps-12 pe-24 text-lg"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            inputMode="search"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('billing.searchPlaceholder')}
            aria-label={t('billing.searchPlaceholder')}
            role="combobox"
            aria-expanded={dropOpen}
            aria-controls="search-results"
            aria-activedescendant={active >= 0 ? `hit-${active}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitSearch();
              } else if (e.key === 'ArrowDown' && dropOpen) {
                e.preventDefault();
                setActive((a) => Math.min(hits.length - 1, a + 1));
              } else if (e.key === 'ArrowUp' && dropOpen) {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              }
            }}
          />
          <span className="absolute end-4 top-1/2 -translate-y-1/2" aria-hidden="true">
            <Kbd>F2</Kbd>
          </span>
          {dropOpen && hits.length > 0 ? (
            <ul
              id="search-results"
              role="listbox"
              className="absolute inset-x-0 top-full z-30 mt-1 max-h-[50dvh] overflow-auto rounded-xl border border-line bg-surface shadow-xl"
            >
              {hits.map((h, i) => (
                <li
                  key={h.kind === 'phone_unit' ? h.item.unit.id : h.item.variant.id}
                  id={`hit-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addHit(h);
                  }}
                  className={`flex min-h-12 cursor-pointer items-center gap-3 border-b border-line px-4 py-2 last:border-0 ${i === active ? 'bg-primary-soft' : ''}`}
                >
                  {h.kind === 'phone_unit' ? (
                    <>
                      <span className="flex-1">
                        <span className="block font-semibold">{h.item.label}</span>
                        <span className="ltr block font-mono text-xs text-muted">
                          {h.item.unit.imei1 ?? h.item.unit.serial} · {h.item.unit.colour ?? ''}
                        </span>
                      </span>
                      <PtaBadge status={h.item.unit.ptaStatus} />
                      <ConditionBadge condition={h.item.unit.condition} />
                      <Money value={h.item.unit.salePrice} className="font-semibold" />
                    </>
                  ) : (
                    <>
                      <span className="flex-1">
                        <span className="block font-semibold">{h.item.label}</span>
                        <span className="ltr block text-xs text-muted">{h.item.variant.sku}</span>
                      </span>
                      <Badge tone={h.item.lowStock ? 'warning' : 'muted'}>
                        {t('inv.onHand', { n: variantQtyText(h.item.onHand, h.item.variant) })}
                      </Badge>
                      <span className="whitespace-nowrap">
                        <Money value={h.item.variant.salePrice} className="font-semibold" />
                        <span className="ltr text-xs text-muted">
                          {perUnit(h.item.variant.unitScale, h.item.variant.unitLabel)}
                        </span>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="tbl-wrap">
          {lines.length === 0 ? (
            <Empty
              icon={<ShoppingCart size={28} aria-hidden="true" />}
              title={t('billing.emptyTitle')}
              hint={t('billing.emptyHint')}
              action={
                <Button variant="secondary" size="sm" onClick={() => setHelpOpen(true)}>
                  <Keyboard size={14} aria-hidden="true" />
                  {t('sc.title')} <Kbd>F1</Kbd>
                </Button>
              }
            />
          ) : (
            <table className="tbl tbl-cards">
              <thead>
                <tr>
                  <th className="w-10">#</th>
                  <th>{t('billing.item')}</th>
                  <th className="text-center">{t('billing.qty')}</th>
                  <th className="num">{t('billing.price')}</th>
                  <th>{t('billing.discount')}</th>
                  <th className="num">{t('billing.lineTotal')}</th>
                  <th className="w-12">
                    <span className="sr-only">{t('common.remove')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr
                    key={l.key}
                    aria-selected={i === cart.selected}
                    onClick={() => cart.select(i)}
                  >
                    <td className="cart-n num text-muted">{i + 1}</td>
                    <td className="cart-item">
                      <div className="font-semibold">{l.label}</div>
                      {l.sub ? <div className="ltr text-xs text-muted">{l.sub}</div> : null}
                    </td>
                    <td className="cart-qty">
                      {l.kind === 'phone' ? (
                        <div className="text-center font-semibold">1</div>
                      ) : lineScale(l) !== 1 ? (
                        <WeightCell line={l} onResult={report} />
                      ) : (
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            variant="secondary"
                            icon
                            size="sm"
                            aria-label={t('billing.decrease')}
                            disabled={l.qty <= 1}
                            onClick={() => cart.setQty(l.key, l.qty - 1)}
                          >
                            <Minus size={14} aria-hidden="true" />
                          </Button>
                          <span className="num w-8 text-center font-semibold" aria-live="polite">
                            {l.qty}
                          </span>
                          <Button
                            variant="secondary"
                            icon
                            size="sm"
                            aria-label={t('billing.increase')}
                            onClick={() => report(cart.setQty(l.key, l.qty + 1), maxTextOf(l))}
                          >
                            <Plus size={14} aria-hidden="true" />
                          </Button>
                        </div>
                      )}
                    </td>
                    <td className="cart-price num ltr">
                      {formatRs(l.unitPrice, { symbol: null })}
                      {lineScale(l) !== 1 ? (
                        <span className="text-xs text-muted">
                          {perUnit(lineScale(l), l.unitLabel)}
                        </span>
                      ) : null}
                    </td>
                    <td className="cart-disc">
                      <DiscountCell line={l} />
                    </td>
                    <td className="cart-total num ltr font-semibold">
                      {formatRs(lineTotalOf(i, l), { symbol: null })}
                    </td>
                    <td className="cart-del">
                      <Button
                        variant="ghost"
                        icon
                        size="sm"
                        aria-label={t('common.remove')}
                        onClick={() => cart.remove(l.key)}
                      >
                        <Trash size={16} aria-hidden="true" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {pv.error ? (
          <div
            role="alert"
            className="rounded-xl border border-danger bg-danger-soft px-4 py-3 text-sm font-medium text-[var(--danger-ink)]"
          >
            {errorMessage(pv.error, t)}
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------ right: summary */}
      <aside className="flex flex-col gap-4 xl:sticky xl:top-20" aria-label={t('billing.summary')}>
        <button
          type="button"
          onClick={() => setCustomerOpen(true)}
          className="card flex min-h-14 items-center gap-3 px-4 text-start transition-colors hover:bg-surface-2"
        >
          <span
            className="grid size-9 place-items-center rounded-full bg-surface-2 text-muted"
            aria-hidden="true"
          >
            <UserRound size={18} />
          </span>
          <span className="flex-1">
            <span className="panel-title block">{t('billing.customer')}</span>
            <span className="block font-semibold">
              {cart.customer?.name ?? t('billing.walkIn')}
            </span>
            {preview?.customerBalance ? (
              <span className="block text-xs text-muted">
                {t('customers.balance')}: <Money value={preview.customerBalance} />
                {preview.creditLimit !== null ? (
                  <>
                    {' '}
                    / {t('customers.creditLimit')}: <Money value={preview.creditLimit} />
                  </>
                ) : null}
              </span>
            ) : null}
          </span>
          {cart.customer ? (
            <span
              role="button"
              tabIndex={0}
              aria-label={t('billing.clearCustomer')}
              className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2"
              onClick={(e) => {
                e.stopPropagation();
                cart.setCustomer(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  cart.setCustomer(null);
                }
              }}
            >
              <X size={16} aria-hidden="true" />
            </span>
          ) : (
            <Kbd>F4</Kbd>
          )}
        </button>

        <div className="slip p-5">
          <div className="flex flex-col gap-1.5">
            <div className="slip-row">
              <span>{t('billing.gross')}</span>
              <b className="num ltr">{formatRs(gross, { symbol: null })}</b>
            </div>
            <div className="slip-row">
              <span>{t('billing.lineDiscounts')}</span>
              <b className="num ltr">-{formatRs(preview?.lineDiscounts ?? 0, { symbol: null })}</b>
            </div>
            <div className="slip-row">
              <span className="flex items-center gap-2">
                {t('billing.invoiceDiscount')}
                <button
                  type="button"
                  className="rounded-md p-1 text-primary-ink hover:bg-primary-soft disabled:opacity-40"
                  aria-label={t('billing.invoiceDiscount')}
                  disabled={lines.length === 0}
                  onClick={() => setDiscountOpen(true)}
                >
                  <Percent size={14} aria-hidden="true" />
                </button>
              </span>
              <b className="num ltr">-{formatRs(cart.invoiceDiscount, { symbol: null })}</b>
            </div>
          </div>
          <div className="my-4 border-t border-dashed border-line" />
          <div className="flex items-end justify-between gap-2">
            <span className="text-sm font-semibold text-muted">{t('billing.total')}</span>
            <span className="slip-total ltr" aria-live="polite">
              <span className="me-1.5 text-base font-semibold text-muted">Rs</span>
              {formatRs(total, { symbol: null })}
            </span>
          </div>
          {preview && preview.effectiveDiscountBps > 0 ? (
            <div className="mt-2 text-end text-xs text-muted">
              {t('billing.effectiveDiscount', {
                pct: `${Math.floor(preview.effectiveDiscountBps / 100)}.${String(preview.effectiveDiscountBps % 100).padStart(2, '0')}`,
              })}
            </div>
          ) : null}
        </div>

        {needsApproval.length > 0 ? (
          <div
            role="status"
            className="flex items-center gap-3 rounded-xl border border-warning bg-warning-soft p-3 text-[var(--warning-ink)]"
          >
            <div className="flex-1 text-sm font-medium">
              {approved ? t('billing.approvedBy') : t('billing.needsApproval')}
            </div>
            {!approved ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setApproval({ reason: needsApproval[0] ?? REASON_FALLBACK, then: 'pay' })
                }
              >
                {t('approval.title')}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            disabled={lines.length === 0}
            onClick={() => {
              cart.hold(total);
              toast.info(t('billing.held'));
              focusSearch();
            }}
          >
            <CirclePause size={16} aria-hidden="true" />
            {t('billing.hold')} <Kbd>F7</Kbd>
          </Button>
          <Button variant="secondary" onClick={() => setHeldOpen(true)}>
            {t('billing.resume')}
            {cart.held.length > 0 ? <Badge tone="primary">{cart.held.length}</Badge> : null}{' '}
            <Kbd>F8</Kbd>
          </Button>
        </div>
        <Button
          variant="success"
          size="lg"
          className="w-full"
          disabled={!preview || !!pv.error || lines.length === 0}
          onClick={startPay}
        >
          {t('billing.pay')}
          <Kbd>F9</Kbd>
        </Button>
        {lines.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setClearOpen(true)}>
            {t('billing.clearCart')}
          </Button>
        ) : null}
      </aside>

      {/* ------------------------------------------------ dialogs */}
      <ImeiPicker
        units={imeiUnits}
        onClose={() => {
          setImeiUnits(null);
          focusSearch();
        }}
        onPick={(u) => {
          report(cart.addPhone(u));
          setImeiUnits(null);
          setQ('');
          focusSearch();
        }}
      />
      <CustomerPicker
        open={customerOpen}
        onClose={() => {
          setCustomerOpen(false);
          focusSearch();
        }}
        onPick={(c) => {
          cart.setCustomer(c);
          setCustomerOpen(false);
          focusSearch();
        }}
      />
      <InvoiceDiscountDialog
        open={discountOpen}
        subtotal={preview?.subtotal ?? 0}
        current={cart.invoiceDiscount}
        onClose={() => setDiscountOpen(false)}
        onApply={(v) => {
          cart.setInvoiceDiscount(v);
          setDiscountOpen(false);
          focusSearch();
        }}
      />
      <PaymentPanel
        open={payOpen}
        total={total}
        hasCustomer={cart.customer !== null}
        busy={payBusy}
        error={payError}
        onClose={() => setPayOpen(false)}
        onConfirm={(p) => void doCommit(p, cart.approvalToken)}
      />
      <ApprovalDialog
        open={approval !== null}
        reason={approval?.reason ?? REASON_FALLBACK}
        onClose={() => setApproval(null)}
        onGranted={onGranted}
      />
      <ReceiptDialog
        invoiceId={receiptId}
        closeLabel={t('billing.newSale')}
        onClose={() => {
          setReceiptId(null);
          focusSearch();
        }}
      />

      <Dialog
        open={heldOpen}
        onClose={() => setHeldOpen(false)}
        width={560}
        title={t('billing.heldBills')}
      >
        {cart.held.length === 0 ? (
          <Empty title={t('billing.noHeld')} />
        ) : (
          <ul className="flex flex-col gap-2">
            {cart.held.map((h, i) => (
              <li key={h.id} className="flex items-center gap-3 rounded-xl border border-line p-3">
                <div className="flex-1">
                  <div className="font-semibold">
                    {formatTime(h.heldAt)} · {h.customer?.name ?? t('billing.walkIn')}
                  </div>
                  <div className="text-sm text-muted">
                    {t('billing.itemsCount', { n: h.lines.length })}
                    {h.total > 0 ? (
                      <>
                        {' '}
                        · <Money value={h.total} />
                      </>
                    ) : null}
                  </div>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  data-autofocus={i === 0 ? true : undefined}
                  onClick={() => {
                    cart.resume(h.id);
                    setHeldOpen(false);
                    focusSearch();
                  }}
                >
                  {t('billing.resume')}
                </Button>
                <Button
                  variant="ghost"
                  icon
                  size="sm"
                  aria-label={t('common.delete')}
                  onClick={() => cart.deleteHeld(h.id)}
                >
                  <Trash size={16} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} width={460} title={t('sc.title')}>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
          {shortcutRows.map(([k, label]) => (
            <div key={k} className="contents">
              <dt>
                <Kbd>{k}</Kbd>
              </dt>
              <dd className="text-sm">{t(label)}</dd>
            </div>
          ))}
        </dl>
      </Dialog>

      <Dialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        width={400}
        title={t('billing.clearCart')}
        footer={
          <>
            <Button onClick={() => setClearOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              data-autofocus
              onClick={() => {
                cart.clear();
                setClearOpen(false);
                focusSearch();
              }}
            >
              {t('billing.clearCart')}
            </Button>
          </>
        }
      >
        <p>{t('billing.clearConfirm')}</p>
      </Dialog>
    </div>
  );
}
