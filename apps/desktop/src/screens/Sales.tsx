import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Ban, Eye, Search, Undo2 } from 'lucide-react';
import {
  isServiceError,
  type ApprovalReason,
  type InvoiceSummary,
  type PaymentInput,
  type PaymentMethod,
  type ReturnPreview,
} from '@pos/shared';
import { ApprovalDialog } from '../components/ApprovalDialog';
import { ReceiptDialog } from '../components/ReceiptDialog';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input } from '../components/ui/Field';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { nicheKey } from '../i18n/niche';
import { useShopModules } from '../service/use-modules';
import { errorMessage } from '../i18n/errors';
import { useBusyAction } from '../lib/busy-action';
import { formatDateTime, localDayRange } from '../lib/dates';
import { paisaToInput, parseRupees } from '../lib/money';
import { labelFor, perUnit, qtyText } from '../lib/qty';
import {
  hasBadPick,
  remainingText,
  returnPick,
  returnPickList,
  type ReturnPick,
} from '../lib/return-qty';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { useCan } from '../store/session';
import { toast } from '../store/toast';

// ------------------------------------------------------------------ return dialog
function ReturnDialog({
  invoice,
  onClose,
}: {
  invoice: InvoiceSummary | null;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  // one box per line: the text as typed and what it means (base units, or why it cannot be returned)
  const [picks, setPicks] = useState<Record<string, ReturnPick>>({});
  const [preview, setPreview] = useState<ReturnPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refund, setRefund] = useState<{ method: PaymentMethod; amount: string }[]>([]);
  const [reason, setReason] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [approvalFor, setApprovalFor] = useState<ApprovalReason | null>(null);

  useEffect(() => {
    if (invoice) {
      setPicks({});
      setPreview(null);
      setError(null);
      setRefund([]);
      setReason('');
      setSubmitError(null);
    }
  }, [invoice]);

  const pickList = useMemo(() => returnPickList(picks), [picks]);
  const badPick = hasBadPick(picks);

  useEffect(() => {
    if (!invoice) return;
    let live = true;
    service.checkout
      .previewReturn(invoice.id, pickList)
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setError(null);
        setRefund(
          p.suggestedRefund.map((r) => ({
            method: r.method,
            amount: paisaToInput(Math.abs(r.amount)),
          })),
        );
      })
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [invoice, pickList, service]);

  const refundTotal = refund.reduce((a, r) => a + (parseRupees(r.amount) ?? 0), 0);
  const target = Math.abs(preview?.total ?? 0);
  const ok =
    pickList.length > 0 &&
    !badPick &&
    refund.every((r) => parseRupees(r.amount) !== null) &&
    refundTotal === target &&
    reason.trim() !== '';

  const { busy, run: submit } = useBusyAction(async (token?: string): Promise<void> => {
    if (!invoice || !ok) return;
    setSubmitError(null);
    try {
      const refunds: PaymentInput[] = refund
        .map((r) => ({ method: r.method, amount: parseRupees(r.amount) ?? 0 }))
        .filter((r) => r.amount > 0);
      const inv = await service.checkout.createReturn({
        originalSaleId: invoice.id,
        lines: pickList,
        refund: refunds,
        reason: reason.trim(),
        ...(token ? { approvalToken: token } : {}),
      });
      toast.success(t('sales.returnDone', { no: inv.invoiceNo }));
      bump();
      onClose();
    } catch (e) {
      if (isServiceError(e) && e.code === 'APPROVAL_REQUIRED') setApprovalFor('return');
      else setSubmitError(errorMessage(e, t));
    }
  });

  return (
    <>
      <Dialog
        open={invoice !== null}
        onClose={onClose}
        width={720}
        dismissable={!busy}
        title={`${t('sales.return')} · ${invoice?.invoiceNo ?? ''}`}
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={!ok} loading={busy} onClick={() => void submit()}>
              {t('sales.confirmReturn')}
            </Button>
          </>
        }
      >
        {error ? (
          <ErrorBox error={error} />
        ) : !preview ? (
          <SkeletonRows rows={3} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('billing.item')}</th>
                    <th className="num">{t('sales.sold')}</th>
                    <th className="num">{t('sales.returned')}</th>
                    <th className="num">{t('billing.price')}</th>
                    <th className="w-32">{t('sales.returnQty')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l) => {
                    // an invoice line knows only its scale: weighed goods read in kg, like the receipt
                    const unit = labelFor(l.unitScale);
                    const pick = picks[l.lineId];
                    const bad = pick?.status === 'invalid' || pick?.status === 'tooMuch';
                    return (
                      <tr key={l.lineId}>
                        <td className="font-semibold">{l.description}</td>
                        <td className="num">{qtyText(l.soldQty, l.unitScale, unit)}</td>
                        <td className="num">{qtyText(l.returnedQty, l.unitScale, unit)}</td>
                        <td className="num">
                          <Money value={l.unitPrice} symbol={null} />
                          {perUnit(l.unitScale, unit)}
                        </td>
                        <td>
                          <div className="flex items-center gap-1">
                            <Input
                              className="input-sm ltr w-24 text-end"
                              inputMode={l.unitScale === 1 ? 'numeric' : 'decimal'}
                              aria-label={`${t('sales.returnQty')} ${l.description}`}
                              title={
                                pick?.status === 'invalid' ? t('billing.weightInvalid') : undefined
                              }
                              invalid={bad}
                              disabled={l.remainingQty <= 0}
                              value={pick?.text ?? ''}
                              placeholder={`0 / ${remainingText(l)}`}
                              onChange={(e) =>
                                setPicks((p) => ({
                                  ...p,
                                  [l.lineId]: returnPick(e.target.value, l),
                                }))
                              }
                            />
                            {l.unitScale === 1 ? null : (
                              <span className="ltr text-xs font-semibold text-muted">{unit}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {pickList.length > 0 ? (
              <div className="rounded-xl bg-surface-2 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="panel-title">{t('sales.refund')}</span>
                  <Money value={target} className="text-xl font-bold" />
                </div>
                <div className="flex flex-col gap-2">
                  {refund.map((r, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-32 text-sm font-medium">
                        {t(dynKey('method', r.method))}
                      </span>
                      <Input
                        value={r.amount}
                        inputMode="decimal"
                        className="ltr text-end"
                        aria-label={`${t('sales.refund')} ${t(dynKey('method', r.method))}`}
                        invalid={parseRupees(r.amount) === null}
                        onChange={(e) =>
                          setRefund((rs) =>
                            rs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
                {refundTotal !== target ? (
                  <p className="mt-2 text-sm font-medium text-[var(--danger-ink)]">
                    {t('sales.refundMismatch')} <Money value={target - refundTotal} />
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted">{t('sales.pickLines')}</p>
            )}

            <Field label={t('sales.reason')}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div role="alert" className="min-h-5 text-sm font-medium text-[var(--danger-ink)]">
              {submitError}
            </div>
          </div>
        )}
      </Dialog>
      <ApprovalDialog
        open={approvalFor !== null}
        reason={approvalFor ?? 'return'}
        onClose={() => setApprovalFor(null)}
        onGranted={(token) => {
          setApprovalFor(null);
          void submit(token);
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ void dialog
function VoidDialog({
  invoice,
  onClose,
}: {
  invoice: InvoiceSummary | null;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needApproval, setNeedApproval] = useState(false);
  useEffect(() => {
    if (invoice) {
      setReason('');
      setError(null);
    }
  }, [invoice]);

  const { busy, run: submit } = useBusyAction(async (token?: string): Promise<void> => {
    if (!invoice || !reason.trim()) return;
    setError(null);
    try {
      const inv = await service.checkout.voidSale({
        originalSaleId: invoice.id,
        reason: reason.trim(),
        ...(token ? { approvalToken: token } : {}),
      });
      toast.success(t('sales.voidDone', { no: inv.invoiceNo }));
      bump();
      onClose();
    } catch (e) {
      if (isServiceError(e) && e.code === 'APPROVAL_REQUIRED') setNeedApproval(true);
      else setError(errorMessage(e, t));
    }
  });

  return (
    <>
      <Dialog
        open={invoice !== null}
        onClose={onClose}
        width={460}
        dismissable={!busy}
        title={`${t('sales.void')} · ${invoice?.invoiceNo ?? ''}`}
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={!reason.trim()}
              loading={busy}
              onClick={() => void submit()}
            >
              {t('sales.confirmVoid')}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm">{t('sales.voidWarning')}</p>
        <Field label={t('sales.reason')}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
        </Field>
        <div role="alert" className="mt-3 min-h-5 text-sm font-medium text-[var(--danger-ink)]">
          {error}
        </div>
      </Dialog>
      <ApprovalDialog
        open={needApproval}
        reason="void"
        onClose={() => setNeedApproval(false)}
        onGranted={(token) => {
          setNeedApproval(false);
          void submit(token);
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ screen
export function Sales(): ReactNode {
  const t = useT();
  const hasImei = useShopModules().has('imei');
  const can = useCan();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [view, setView] = useState<string | null>(null);
  const [ret, setRet] = useState<InvoiceSummary | null>(null);
  const [voiding, setVoiding] = useState<InvoiceSummary | null>(null);

  const list = useServiceQuery(
    (s) =>
      s.checkout.listInvoices({
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(from ? { fromMs: localDayRange(from).fromMs } : {}),
        ...(to ? { toMs: localDayRange(to).toMs } : {}),
        limit: 200,
      }),
    [q, from, to],
  );

  return (
    <div>
      <PageHeader title={t('nav.sales')} subtitle={t('sales.subtitle')} />
      <div className="mb-3 flex flex-wrap items-end gap-3">
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
            placeholder={t(nicheKey(hasImei, 'sales.searchPlaceholder'))}
            aria-label={t(nicheKey(hasImei, 'sales.searchPlaceholder'))}
          />
        </div>
        <Field label={t('sales.from')}>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="ltr w-auto"
          />
        </Field>
        <Field label={t('sales.to')}>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="ltr w-auto"
          />
        </Field>
      </div>

      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : (
        <div className="tbl-wrap">
          {list.loading && !list.data ? (
            <SkeletonRows />
          ) : (list.data ?? []).length === 0 ? (
            <Empty title={t('sales.none')} hint={t('sales.noneHint')} />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('sales.invoice')}</th>
                  <th>{t('sales.date')}</th>
                  <th>{t('sales.kind')}</th>
                  <th>{t('billing.customer')}</th>
                  <th>{t('receipt.cashier')}</th>
                  <th className="num">{t('billing.total')}</th>
                  <th className="w-56">
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((i) => (
                  <tr key={i.id}>
                    <td className="ltr font-mono text-sm font-semibold">{i.invoiceNo}</td>
                    <td className="ltr text-sm">{formatDateTime(i.createdAt)}</td>
                    <td>
                      <Badge
                        tone={
                          i.kind === 'sale' ? 'primary' : i.kind === 'return' ? 'warning' : 'danger'
                        }
                      >
                        {t(dynKey('kind', i.kind))}
                      </Badge>
                      {i.returnedTotal > 0 ? (
                        <span className="ms-1">
                          <Badge tone="warning">{t('sales.partlyReturned')}</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {i.customerName ?? <span className="text-muted">{t('billing.walkIn')}</span>}
                    </td>
                    <td>{i.cashierName}</td>
                    <td className="num">
                      <Money
                        value={i.total}
                        symbol={null}
                        className={`font-semibold ${i.total < 0 ? 'text-[var(--danger-ink)]' : ''}`}
                      />
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setView(i.id)}>
                          <Eye size={15} aria-hidden="true" />
                          {t('sales.view')}
                        </Button>
                        {i.kind === 'sale' && (can('return_void') || can('sell')) ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={i.returnedTotal >= i.total}
                              onClick={() => setRet(i)}
                            >
                              <Undo2 size={15} aria-hidden="true" />
                              {t('sales.return')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={i.returnedTotal >= i.total}
                              onClick={() => setVoiding(i)}
                            >
                              <Ban size={15} aria-hidden="true" />
                              {t('sales.void')}
                            </Button>
                          </>
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

      <ReceiptDialog invoiceId={view} onClose={() => setView(null)} />
      <ReturnDialog invoice={ret} onClose={() => setRet(null)} />
      <VoidDialog invoice={voiding} onClose={() => setVoiding(null)} />
    </div>
  );
}
