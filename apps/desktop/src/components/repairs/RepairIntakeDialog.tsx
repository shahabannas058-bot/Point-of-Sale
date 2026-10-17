import { useEffect, useState, type ReactNode } from 'react';
import { UserRound, X } from 'lucide-react';
import { PAYMENT_METHODS, type PaymentMethod, type RepairTicketView } from '@pos/shared';
import { dynKey, useT } from '../../i18n';
import { errorMessage } from '../../i18n/errors';
import { parseRupees } from '../../lib/money';
import { useService } from '../../service/context';
import { useDataVersion } from '../../store/data-version';
import { toast } from '../../store/toast';
import { CustomerPicker } from '../CustomerPicker';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Select, Textarea } from '../ui/Field';

type CashMethod = Exclude<PaymentMethod, 'khata'>;
const CASH_METHODS = PAYMENT_METHODS.filter((m): m is CashMethod => m !== 'khata');

const EMPTY = {
  walkInName: '',
  walkInPhone: '',
  brand: '',
  model: '',
  imei: '',
  serial: '',
  problem: '',
  condition: '',
  accessories: '',
  estimate: '',
  advance: '',
  method: 'cash' as CashMethod,
  promised: '',
};

/** Parses a <input type="date"> value as the end of that local day. */
function promisedAt(ymd: string): number | null {
  if (!ymd) return null;
  const d = new Date(`${ymd}T18:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Device intake at the counter: who, which phone, what is wrong, estimate and an optional advance. */
export function RepairIntakeDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (v: RepairTicketView) => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [f, setF] = useState(EMPTY);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setF(EMPTY);
      setCustomer(null);
      setErr(null);
    }
  }, [open]);

  const set =
    (k: keyof typeof EMPTY) =>
    (e: { target: { value: string } }): void =>
      setF((s) => ({ ...s, [k]: e.target.value }));

  const estimate = f.estimate.trim() === '' ? 0 : parseRupees(f.estimate);
  const advance = f.advance.trim() === '' ? 0 : parseRupees(f.advance);
  const hasWho = customer !== null || f.walkInName.trim() !== '';
  const valid =
    hasWho &&
    f.brand.trim() !== '' &&
    f.model.trim() !== '' &&
    f.problem.trim() !== '' &&
    estimate !== null &&
    advance !== null;

  const submit = async (): Promise<void> => {
    if (!valid || busy || estimate === null || advance === null) return;
    setBusy(true);
    setErr(null);
    try {
      const v = await service.repairs.create({
        customerId: customer?.id ?? null,
        walkIn: customer
          ? null
          : { name: f.walkInName.trim(), phone: f.walkInPhone.trim() || null },
        deviceBrand: f.brand.trim(),
        deviceModel: f.model.trim(),
        imei: f.imei.trim() || null,
        serial: f.serial.trim() || null,
        problem: f.problem.trim(),
        conditionNotes: f.condition.trim() || null,
        accessories: f.accessories.trim() || null,
        estimatedCost: estimate,
        advance: advance > 0 ? { amount: advance, method: f.method } : null,
        promisedAt: promisedAt(f.promised),
      });
      bump();
      toast.success(t('repair.created', { no: v.ticket.ticketNo }));
      onCreated(v);
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        width={720}
        dismissable={!busy}
        title={t('repair.new')}
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!valid}
              loading={busy}
              onClick={() => void submit()}
            >
              {t('repair.createTicket')}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <section className="flex flex-col gap-3">
            <div className="panel-title">{t('repair.secCustomer')}</div>
            {customer ? (
              <div className="glass-i card flex items-center gap-3 px-3 py-2">
                <UserRound size={18} aria-hidden="true" className="text-[var(--primary-ink)]" />
                <span className="flex-1 font-semibold">{customer.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon
                  aria-label={t('common.remove')}
                  onClick={() => setCustomer(null)}
                >
                  <X size={16} aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field label={t('repair.walkInName')}>
                  <Input value={f.walkInName} onChange={set('walkInName')} data-autofocus />
                </Field>
                <Field label={t('customers.phone')}>
                  <Input
                    value={f.walkInPhone}
                    onChange={set('walkInPhone')}
                    inputMode="tel"
                    className="ltr"
                  />
                </Field>
                <Button onClick={() => setPicking(true)}>
                  <UserRound size={16} aria-hidden="true" />
                  {t('repair.pickCustomer')}
                </Button>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <div className="panel-title">{t('repair.secDevice')}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('repair.brand')}>
                <Input value={f.brand} onChange={set('brand')} placeholder="Samsung" />
              </Field>
              <Field label={t('repair.model')}>
                <Input value={f.model} onChange={set('model')} placeholder="Galaxy A15" />
              </Field>
              <Field label="IMEI" hint={t('repair.imeiHint')}>
                <Input
                  value={f.imei}
                  onChange={set('imei')}
                  inputMode="numeric"
                  maxLength={15}
                  className="ltr num"
                />
              </Field>
              <Field label={t('repair.serial')}>
                <Input value={f.serial} onChange={set('serial')} className="ltr" />
              </Field>
            </div>
            <Field label={t('repair.problem')}>
              <Textarea
                value={f.problem}
                onChange={set('problem')}
                placeholder={t('repair.problemPlaceholder')}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('repair.condition')} hint={t('repair.conditionHint')}>
                <Input value={f.condition} onChange={set('condition')} />
              </Field>
              <Field label={t('repair.accessories')} hint={t('repair.accessoriesHint')}>
                <Input value={f.accessories} onChange={set('accessories')} />
              </Field>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <div className="panel-title">{t('repair.secMoney')}</div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label={t('repair.estimate')}>
                <Input
                  value={f.estimate}
                  onChange={set('estimate')}
                  inputMode="decimal"
                  className="ltr num"
                  invalid={estimate === null}
                />
              </Field>
              <Field label={t('repair.advance')}>
                <Input
                  value={f.advance}
                  onChange={set('advance')}
                  inputMode="decimal"
                  className="ltr num"
                  invalid={advance === null}
                />
              </Field>
              <Field label={t('pay.method')}>
                <Select value={f.method} onChange={set('method')} disabled={!advance}>
                  {CASH_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(dynKey('method', m))}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('repair.promised')}>
                <Input type="date" value={f.promised} onChange={set('promised')} className="ltr" />
              </Field>
            </div>
          </section>

          {err ? (
            <div role="alert" className="text-sm font-medium text-[var(--danger-ink)]">
              {err}
            </div>
          ) : null}
          {/* lets Enter in a single-line field submit */}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      </Dialog>
      <CustomerPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(c) => {
          setCustomer(c);
          setPicking(false);
        }}
      />
    </>
  );
}
