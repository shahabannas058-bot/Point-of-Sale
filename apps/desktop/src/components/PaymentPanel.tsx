import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Banknote, BookUser, CreditCard, Landmark, Smartphone, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PAYMENT_METHODS, type PaymentInput, type PaymentMethod } from '@pos/shared';
import { dynKey, useT } from '../i18n';
import { formatRs, paisaToInput, parseRupees } from '../lib/money';
import { useHotkeys } from '../lib/shortcuts';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Input } from './ui/Field';
import { Money } from './ui/misc';

const ICONS: Record<PaymentMethod, LucideIcon> = {
  cash: Banknote,
  khata: BookUser,
  jazzcash: Smartphone,
  easypaisa: Smartphone,
  bank_transfer: Landmark,
  card: CreditCard,
};
const QUICK: PaymentMethod[] = ['cash', 'khata', 'jazzcash', 'easypaisa'];

interface Row {
  id: number;
  method: PaymentMethod;
  amount: string;
}

/** Split-tender payment: rows must add up to the total exactly before Confirm unlocks. */
export function PaymentPanel({
  open,
  total,
  hasCustomer,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  total: number;
  hasCustomer: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (payments: PaymentInput[]) => void;
}): ReactNode {
  const t = useT();
  const [rows, setRows] = useState<Row[]>([]);
  const [tendered, setTendered] = useState('');
  const [seq, setSeq] = useState(1);

  useEffect(() => {
    if (open) {
      setRows([{ id: 0, method: 'cash', amount: paisaToInput(total) }]);
      setTendered('');
      setSeq(1);
    }
    // re-init only when the dialog opens
  }, [open]);

  const parsed = useMemo(() => rows.map((r) => ({ ...r, paisa: parseRupees(r.amount) })), [rows]);
  const paid = parsed.reduce((a, r) => a + (r.paisa ?? 0), 0);
  const remaining = total - paid;
  const anyInvalid = parsed.some((r) => r.paisa === null || r.paisa <= 0);
  const khataBlocked = parsed.some((r) => r.method === 'khata') && !hasCustomer;
  const ok = !anyInvalid && remaining === 0 && !khataBlocked && rows.length > 0;

  const cashRow = parsed.find((r) => r.method === 'cash');
  const tenderedP = parseRupees(tendered);
  const change =
    cashRow?.paisa !== undefined && cashRow.paisa !== null && tenderedP !== null
      ? tenderedP - cashRow.paisa
      : null;

  const addMethod = (m: PaymentMethod): void => {
    setRows((rs) => {
      const sum = rs.reduce((a, r) => a + (parseRupees(r.amount) ?? 0), 0);
      const rest = Math.max(0, total - sum);
      return [...rs, { id: seq, method: m, amount: rest > 0 ? paisaToInput(rest) : '' }];
    });
    setSeq((s) => s + 1);
  };
  const confirm = (): void => {
    if (!ok || busy) return;
    onConfirm(parsed.map((r) => ({ method: r.method, amount: r.paisa ?? 0 })));
  };

  useHotkeys({ 'Ctrl+Enter': confirm }, open);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={600}
      dismissable={!busy}
      title={t('pay.title')}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="success" size="lg" disabled={!ok} loading={busy} onClick={confirm}>
            {t('pay.confirm')} · {formatRs(total)}
            <span className="kbd">Ctrl+Enter</span>
          </Button>
        </>
      }
    >
      <div className="mb-4 flex items-end justify-between rounded-xl bg-surface-2 p-4">
        <div>
          <div className="panel-title">{t('billing.total')}</div>
          <Money value={total} className="text-3xl font-bold" />
        </div>
        <div className="text-end">
          <div className="panel-title">{t('pay.remaining')}</div>
          <Money
            value={remaining}
            className={`text-xl font-bold ${remaining === 0 ? 'text-[var(--success-ink)]' : 'text-[var(--danger-ink)]'}`}
          />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t('pay.addMethod')}>
        {QUICK.map((m) => {
          const Icon = ICONS[m];
          const disabled = m === 'khata' && !hasCustomer;
          return (
            <Button
              key={m}
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => addMethod(m)}
              title={disabled ? t('pay.khataNeedsCustomer') : undefined}
            >
              <Icon size={15} aria-hidden="true" />
              {t(dynKey('method', m))}
            </Button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        {parsed.map((r) => {
          const Icon = ICONS[r.method];
          const invalid = r.paisa === null || r.paisa <= 0;
          return (
            <div key={r.id} className="flex items-center gap-2">
              <span
                className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted"
                aria-hidden="true"
              >
                <Icon size={18} />
              </span>
              <select
                className="select max-w-44"
                value={r.method}
                aria-label={t('pay.method')}
                onChange={(e) => {
                  const m = e.target.value as PaymentMethod;
                  setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, method: m } : x)));
                }}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m} disabled={m === 'khata' && !hasCustomer}>
                    {t(dynKey('method', m))}
                  </option>
                ))}
              </select>
              <Input
                value={r.amount}
                inputMode="decimal"
                aria-label={t('pay.amount')}
                invalid={invalid}
                className="ltr text-end font-semibold"
                onChange={(e) => {
                  const v = e.target.value;
                  setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, amount: v } : x)));
                }}
                onFocus={(e) => e.currentTarget.select()}
              />
              {remaining !== 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const others = parsed
                      .filter((x) => x.id !== r.id)
                      .reduce((a, x) => a + (x.paisa ?? 0), 0);
                    const fill = Math.max(0, total - others);
                    setRows((rs) =>
                      rs.map((x) => (x.id === r.id ? { ...x, amount: paisaToInput(fill) } : x)),
                    );
                  }}
                >
                  {t('pay.fill')}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                icon
                size="sm"
                aria-label={t('common.remove')}
                disabled={rows.length === 1}
                onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
              >
                <X size={16} aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </div>

      {khataBlocked ? (
        <p className="mt-2 text-sm font-medium text-[var(--danger-ink)]">
          {t('pay.khataNeedsCustomer')}
        </p>
      ) : null}

      {cashRow ? (
        <div className="mt-4 grid gap-3 rounded-xl border border-dashed border-line p-3 sm:grid-cols-2">
          <label className="field">
            <span className="label">{t('pay.tendered')}</span>
            <Input
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
              inputMode="decimal"
              className="ltr"
              placeholder="0"
            />
          </label>
          <div className="flex flex-col justify-end">
            <span className="panel-title">{t('pay.change')}</span>
            <Money
              value={change !== null && change > 0 ? change : 0}
              className={`text-2xl font-bold ${change !== null && change < 0 ? 'text-[var(--danger-ink)]' : ''}`}
            />
            {change !== null && change < 0 ? (
              <span className="text-xs text-[var(--danger-ink)]">{t('pay.short')}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div role="alert" className="mt-3 min-h-5 text-sm font-medium text-[var(--danger-ink)]">
        {error}
      </div>
    </Dialog>
  );
}
