import { useEffect, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import {
  PAYMENT_METHODS,
  isServiceError,
  type ApprovalReason,
  type PaymentMethod,
  type RepairTicketView,
  type VariantView,
} from '@pos/shared';
import { dynKey, useT } from '../../i18n';
import { errorMessage } from '../../i18n/errors';
import { paisaToInput, parseRupees } from '../../lib/money';
import { useService } from '../../service/context';
import { useServiceQuery } from '../../service/use-query';
import { useDataVersion } from '../../store/data-version';
import { toast } from '../../store/toast';
import { ApprovalDialog } from '../ApprovalDialog';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Select } from '../ui/Field';
import { Empty, Money, SkeletonRows } from '../ui/misc';

type CashMethod = Exclude<PaymentMethod, 'khata'>;
const CASH_METHODS = PAYMENT_METHODS.filter((m): m is CashMethod => m !== 'khata');

interface ActionProps {
  open: boolean;
  view: RepairTicketView;
  onClose: () => void;
}

/** Shared run-with-approval flow: APPROVAL_REQUIRED opens the manager PIN dialog, then retries with the token. */
function useApprovedAction(reason: ApprovalReason, run: (token?: string) => Promise<void>) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const exec = async (token?: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await run(token);
    } catch (e) {
      if (isServiceError(e) && e.code === 'APPROVAL_REQUIRED' && !token) setAsking(true);
      else setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const approval = (
    <ApprovalDialog
      open={asking}
      reason={reason}
      onClose={() => setAsking(false)}
      onGranted={(tok) => {
        setAsking(false);
        void exec(tok);
      }}
    />
  );
  return { busy, error, setError, exec, approval };
}

function ErrorLine({ text }: { text: string | null }): ReactNode {
  return text ? (
    <div role="alert" className="text-sm font-medium text-[var(--danger-ink)]">
      {text}
    </div>
  ) : null;
}

// ---------------- spare part ----------------

export function AddPartDialog({ open, view, onClose }: ActionProps): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<VariantView | null>(null);
  const [qty, setQty] = useState('1');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hits = useServiceQuery(
    (s) => s.catalog.search(q.trim(), { limit: 20, inStockOnly: true }),
    [q],
    open && q.trim().length > 0,
  );
  const variants = (hits.data ?? []).flatMap((h) => (h.kind === 'variant' ? [h.item] : []));

  useEffect(() => {
    if (open) {
      setQ('');
      setPicked(null);
      setQty('1');
      setErr(null);
    }
  }, [open]);

  const n = Number.parseInt(qty, 10);
  const qtyOk = Number.isInteger(n) && n > 0 && (picked === null || n <= picked.onHand);

  const save = async (): Promise<void> => {
    if (!picked || !qtyOk || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await service.repairs.addPart({
        ticketId: view.ticket.id,
        variantId: picked.variant.id,
        quantity: n,
      });
      bump();
      toast.success(t('repair.partAdded'));
      onClose();
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={560}
      dismissable={!busy}
      title={t('repair.addPart')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!picked || !qtyOk}
            loading={busy}
            onClick={() => void save()}
          >
            {t('repair.usePart')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPicked(null);
            }}
            className="ps-9"
            placeholder={t('repair.partSearch')}
            aria-label={t('repair.partSearch')}
            data-autofocus
          />
        </div>
        <div className="tbl-wrap max-h-64">
          {q.trim() === '' ? (
            <Empty title={t('repair.partSearchHint')} />
          ) : hits.loading && !hits.data ? (
            <SkeletonRows rows={3} />
          ) : variants.length === 0 ? (
            <Empty title={t('repair.partNone')} />
          ) : (
            <table className="tbl">
              <tbody>
                {variants.map((v) => (
                  <tr
                    key={v.variant.id}
                    aria-selected={picked?.variant.id === v.variant.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setPicked(v)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setPicked(v);
                    }}
                  >
                    <td className="font-medium">{v.label}</td>
                    <td className="num text-sm text-muted">
                      {t('repair.onHand', { n: v.onHand })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Field
          label={t('billing.qty')}
          error={picked && !qtyOk ? t('repair.qtyInvalid') : undefined}
        >
          <Input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            inputMode="numeric"
            className="ltr num"
          />
        </Field>
        <ErrorLine text={err} />
      </div>
    </Dialog>
  );
}

// ---------------- charges / promise date ----------------

const toYmd = (ms: number | null): string => {
  if (ms === null) return '';
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function EditChargesDialog({ open, view, onClose }: ActionProps): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const tk = view.ticket;
  const [estimate, setEstimate] = useState('');
  const [final, setFinal] = useState('');
  const [promised, setPromised] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEstimate(paisaToInput(tk.estimatedCost));
      setFinal(tk.finalCharge === null ? '' : paisaToInput(tk.finalCharge));
      setPromised(toYmd(tk.promisedAt));
      setErr(null);
    }
  }, [open, tk]);

  const est = parseRupees(estimate);
  const fin = final.trim() === '' ? null : parseRupees(final);
  const finInvalid = final.trim() !== '' && fin === null;

  const save = async (): Promise<void> => {
    if (est === null || finInvalid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await service.repairs.update(tk.id, {
        estimatedCost: est,
        finalCharge: fin,
        promisedAt: promised ? new Date(`${promised}T18:00:00`).getTime() : null,
      });
      bump();
      toast.success(t('common.saved'));
      onClose();
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={480}
      dismissable={!busy}
      title={t('repair.editCharges')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={est === null || finInvalid}
            loading={busy}
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('repair.estimate')}>
            <Input
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              inputMode="decimal"
              className="ltr num"
              invalid={est === null}
              data-autofocus
            />
          </Field>
          <Field label={t('repair.finalCharge')} hint={t('repair.finalHint')}>
            <Input
              value={final}
              onChange={(e) => setFinal(e.target.value)}
              inputMode="decimal"
              className="ltr num"
              invalid={finInvalid}
            />
          </Field>
        </div>
        <Field label={t('repair.promised')}>
          <Input
            type="date"
            value={promised}
            onChange={(e) => setPromised(e.target.value)}
            className="ltr"
          />
        </Field>
        <ErrorLine text={err} />
      </div>
    </Dialog>
  );
}

// ---------------- delivery ----------------

export function DeliverDialog({ open, view, onClose }: ActionProps): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const tk = view.ticket;
  const [charge, setCharge] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const finalCharge = parseRupees(charge);
  const due = finalCharge === null ? 0 : finalCharge - view.paidTotal;
  const refund = due < 0;
  const methods = refund || !tk.customerId ? CASH_METHODS : PAYMENT_METHODS;

  const action = useApprovedAction('discount', async (token) => {
    if (finalCharge === null) return;
    await service.repairs.deliver({
      ticketId: tk.id,
      finalCharge,
      payments: due === 0 ? [] : [{ method, amount: Math.abs(due) }],
      approvalToken: token,
    });
    bump();
    toast.success(t('repair.delivered', { no: tk.ticketNo }));
    onClose();
  });

  useEffect(() => {
    if (open) {
      setCharge(paisaToInput(tk.finalCharge ?? tk.estimatedCost));
      setMethod('cash');
      action.setError(null);
    }
    // re-init only when the dialog opens
  }, [open]);

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        width={480}
        dismissable={!action.busy}
        title={t('repair.deliverTitle', { no: tk.ticketNo })}
        footer={
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button
              variant="success"
              disabled={finalCharge === null}
              loading={action.busy}
              onClick={() => void action.exec()}
            >
              {refund
                ? t('repair.deliverRefund')
                : due > 0
                  ? t('repair.deliverCollect')
                  : t('repair.deliver')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t('repair.finalCharge')}>
            <Input
              value={charge}
              onChange={(e) => setCharge(e.target.value)}
              inputMode="decimal"
              className="ltr num text-lg font-semibold"
              invalid={finalCharge === null}
              data-autofocus
            />
          </Field>
          <div className="slip card-pad flex flex-col gap-1.5">
            <div className="slip-row">
              <span>{t('repair.paid')}</span>
              <b>
                <Money value={view.paidTotal} />
              </b>
            </div>
            <div className="slip-row">
              <span>{refund ? t('repair.toRefund') : t('repair.toCollect')}</span>
            </div>
            <div className={`slip-total ${refund ? 'text-[var(--warning-ink)]' : ''}`}>
              <Money value={Math.abs(due)} />
            </div>
          </div>
          {due !== 0 ? (
            <Field label={refund ? t('repair.refundMethod') : t('pay.method')}>
              <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {methods.map((m) => (
                  <option key={m} value={m}>
                    {t(dynKey('method', m))}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <ErrorLine text={action.error} />
        </div>
      </Dialog>
      {action.approval}
    </>
  );
}

// ---------------- cancellation ----------------

export function CancelRepairDialog({ open, view, onClose }: ActionProps): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const tk = view.ticket;
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<CashMethod>('cash');

  const action = useApprovedAction('void', async (token) => {
    await service.repairs.cancel({
      ticketId: tk.id,
      reason: reason.trim(),
      refundMethod: method,
      approvalToken: token,
    });
    bump();
    toast.success(t('repair.cancelled', { no: tk.ticketNo }));
    onClose();
  });

  useEffect(() => {
    if (open) {
      setReason('');
      setMethod('cash');
      action.setError(null);
    }
    // re-init only when the dialog opens
  }, [open]);

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        width={480}
        dismissable={!action.busy}
        title={t('repair.cancelTitle', { no: tk.ticketNo })}
        footer={
          <>
            <Button onClick={onClose}>{t('common.close')}</Button>
            <Button
              variant="danger"
              disabled={reason.trim() === ''}
              loading={action.busy}
              onClick={() => void action.exec()}
            >
              {t('repair.cancelTicket')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={t('repair.cancelReason')}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
          </Field>
          {view.paidTotal > 0 ? (
            <>
              <div className="rounded-xl bg-warning-soft p-3 text-sm font-medium text-[var(--warning-ink)]">
                {t('repair.cancelRefundNote')} <Money value={view.paidTotal} />
              </div>
              <Field label={t('repair.refundMethod')}>
                <Select value={method} onChange={(e) => setMethod(e.target.value as CashMethod)}>
                  {CASH_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(dynKey('method', m))}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}
          <ErrorLine text={action.error} />
        </div>
      </Dialog>
      {action.approval}
    </>
  );
}
