import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Banknote, Printer } from 'lucide-react';
import { PAYMENT_METHODS, type PaymentMethod } from '@pos/shared';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input, Select } from '../components/ui/Field';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { formatDateTime } from '../lib/dates';
import { paisaToInput, parseRupees } from '../lib/money';
import { printPage } from '../lib/print';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { toast } from '../store/toast';

type CashMethod = Exclude<PaymentMethod, 'khata'>;

function PaySupplierDialog({
  open,
  supplierId,
  balance,
  onClose,
}: {
  open: boolean;
  supplierId: string;
  balance: number;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<CashMethod>('cash');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setAmount(balance > 0 ? paisaToInput(balance) : '');
      setMethod('cash');
      setNote('');
      setError(null);
    }
  }, [open, balance]);
  const value = parseRupees(amount);
  const invalid = value === null || value <= 0;
  // paying more than owed is allowed (it becomes an advance) but worth a warning
  const advance = value !== null && value > Math.max(balance, 0);

  const save = async (): Promise<void> => {
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await service.purchasing.paySupplier({
        supplierId,
        amount: value,
        method,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      bump();
      toast.success(t('suppliers.paymentDone'));
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
      width={440}
      dismissable={!busy}
      title={t('suppliers.pay')}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={invalid} loading={busy} onClick={() => void save()}>
            {t('suppliers.payNow')}
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
        <p className="text-sm text-muted">
          {t('suppliers.balance')}:{' '}
          <Money value={balance} className="font-semibold text-[var(--danger-ink)]" />
        </p>
        <Field
          label={t('pay.amount')}
          error={amount && invalid ? t('suppliers.amountInvalid') : null}
          hint={!invalid && advance ? t('suppliers.advanceWarn') : null}
        >
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="ltr text-lg font-semibold"
            data-autofocus
            invalid={!!amount && invalid}
          />
        </Field>
        <Field label={t('pay.method')}>
          <Select value={method} onChange={(e) => setMethod(e.target.value as CashMethod)}>
            {PAYMENT_METHODS.filter((m) => m !== 'khata').map((m) => (
              <option key={m} value={m}>
                {t(dynKey('method', m))}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('inv.note')}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div role="alert" className="min-h-5 text-sm font-medium text-[var(--danger-ink)]">
          {error}
        </div>
        <button type="submit" className="sr-only" tabIndex={-1}>
          {t('suppliers.payNow')}
        </button>
      </form>
    </Dialog>
  );
}

export function SupplierDetail(): ReactNode {
  const t = useT();
  const { id = '' } = useParams();
  const q = useServiceQuery((s) => s.purchasing.getSupplierLedger(id), [id]);
  const [payOpen, setPayOpen] = useState(false);
  const data = q.data;

  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!data) return <SkeletonRows rows={8} />;
  const s = data.supplier;

  const typeLabel = (type: string): string => t(dynKey('ledger', type, 'ledger.adjustment'));

  return (
    <div>
      <div className="no-print mb-2">
        <Link
          to="/suppliers"
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary"
        >
          <ArrowLeft size={16} className="rtl:-scale-x-100" aria-hidden="true" />
          {t('nav.suppliers')}
        </Link>
      </div>
      <PageHeader
        title={s.name}
        subtitle={<span className="ltr">{s.phone ?? '—'}</span>}
        actions={
          <>
            <Button onClick={printPage}>
              <Printer size={16} aria-hidden="true" />
              {t('khata.printStatement')}
            </Button>
            <Button variant="primary" onClick={() => setPayOpen(true)}>
              <Banknote size={16} aria-hidden="true" />
              {t('suppliers.pay')}
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="card card-pad">
          <div className="panel-title">{t('suppliers.balance')}</div>
          <Money
            value={data.balance}
            className={`mt-1 block text-3xl font-bold ${data.balance > 0 ? 'text-[var(--danger-ink)]' : ''}`}
          />
        </div>
        <div className="card card-pad">
          <div className="panel-title">{t('customers.address')}</div>
          <div className="mt-1">{s.address ?? '—'}</div>
        </div>
      </div>

      <div className="tbl-wrap">
        {data.lines.length === 0 ? (
          <Empty title={t('khata.noEntries')} />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('sales.date')}</th>
                <th>{t('khata.entry')}</th>
                <th>{t('suppliers.reference')}</th>
                <th className="num">{t('khata.amount')}</th>
                <th className="num">{t('khata.running')}</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.entry.id}>
                  <td className="ltr text-sm">{formatDateTime(l.entry.createdAt)}</td>
                  <td>
                    <Badge tone={l.entry.amount > 0 ? 'danger' : 'success'}>
                      {typeLabel(l.entry.type)}
                    </Badge>
                    {l.entry.method ? (
                      <span className="ms-2 text-xs text-muted">
                        {t(dynKey('method', l.entry.method))}
                      </span>
                    ) : null}
                    {l.entry.note ? (
                      <span className="ms-2 text-xs text-muted">{l.entry.note}</span>
                    ) : null}
                  </td>
                  <td className="ltr font-mono text-sm">{l.referenceNo ?? '—'}</td>
                  <td className="num">
                    <Money
                      value={l.entry.amount}
                      symbol={null}
                      className={
                        l.entry.amount > 0
                          ? 'text-[var(--danger-ink)]'
                          : 'text-[var(--success-ink)]'
                      }
                    />
                  </td>
                  <td className="num">
                    <Money value={l.runningBalance} symbol={null} className="font-semibold" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <PaySupplierDialog
        open={payOpen}
        supplierId={id}
        balance={data.balance}
        onClose={() => setPayOpen(false)}
      />
    </div>
  );
}
