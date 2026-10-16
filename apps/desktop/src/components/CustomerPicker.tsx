import { useState, type ReactNode } from 'react';
import { Search, UserPlus, UserRound } from 'lucide-react';
import type { Customer } from '@pos/shared';
import { useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { parseRupees } from '../lib/money';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { toast } from '../store/toast';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Field, Input } from './ui/Field';
import { Empty, Money, SkeletonRows } from './ui/misc';

export function CustomerForm({
  onCreated,
  onCancel,
}: {
  onCreated: (c: Customer) => void;
  onCancel: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [f, setF] = useState({ name: '', phone: '', cnic: '', limit: '', opening: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((s) => ({ ...s, [k]: e.target.value }));
  const limit = f.limit.trim() === '' ? null : parseRupees(f.limit);
  const opening = f.opening.trim() === '' ? 0 : parseRupees(f.opening);
  const bad = (f.limit.trim() !== '' && limit === null) || opening === null;

  const submit = async (): Promise<void> => {
    if (!f.name.trim() || bad || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const c = await service.khata.createCustomer({
        name: f.name.trim(),
        phone: f.phone.trim() || null,
        cnic: f.cnic.replace(/\D/g, '') || null,
        creditLimit: limit,
        openingBalance: opening ?? 0,
      });
      bump();
      toast.success(t('customers.created'));
      onCreated(c);
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label={t('customers.name')}>
        <Input value={f.name} onChange={set('name')} data-autofocus required />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('customers.phone')}>
          <Input value={f.phone} onChange={set('phone')} inputMode="tel" className="ltr" />
        </Field>
        <Field label={t('customers.cnic')} hint={t('customers.cnicHint')}>
          <Input
            value={f.cnic}
            onChange={set('cnic')}
            inputMode="numeric"
            maxLength={15}
            className="ltr"
          />
        </Field>
        <Field label={t('customers.creditLimit')} hint={t('customers.creditLimitHint')}>
          <Input
            value={f.limit}
            onChange={set('limit')}
            inputMode="decimal"
            className="ltr"
            invalid={f.limit !== '' && limit === null}
          />
        </Field>
        <Field label={t('customers.openingBalance')}>
          <Input
            value={f.opening}
            onChange={set('opening')}
            inputMode="decimal"
            className="ltr"
            invalid={opening === null}
          />
        </Field>
      </div>
      {err ? (
        <div role="alert" className="text-sm font-medium text-[var(--danger-ink)]">
          {err}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!f.name.trim() || bad} loading={busy}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** Pick a khata customer for the bill, search by name/phone, or create one on the spot. */
export function CustomerPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (c: { id: string; name: string } | null) => void;
}): ReactNode {
  const t = useT();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useServiceQuery((s) => s.khata.listCustomers({ q }), [q], open);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={520}
      title={creating ? t('customers.new') : t('billing.customer')}
    >
      {creating ? (
        <CustomerForm
          onCancel={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            onPick({ id: c.id, name: c.name });
          }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search
              size={16}
              className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('customers.searchPlaceholder')}
              aria-label={t('customers.searchPlaceholder')}
              className="ps-9"
              data-autofocus
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onPick(null)}>
              <UserRound size={16} aria-hidden="true" />
              {t('billing.walkIn')}
            </Button>
            <Button variant="secondary" onClick={() => setCreating(true)}>
              <UserPlus size={16} aria-hidden="true" />
              {t('customers.new')}
            </Button>
          </div>
          <div className="max-h-[44dvh] overflow-auto rounded-xl border border-line">
            {list.loading && !list.data ? (
              <SkeletonRows rows={4} />
            ) : (list.data ?? []).length === 0 ? (
              <Empty title={t('customers.none')} />
            ) : (
              <ul>
                {(list.data ?? []).map((r) => (
                  <li key={r.party.id} className="border-b border-line last:border-0">
                    <button
                      type="button"
                      className="flex min-h-14 w-full items-center gap-3 px-4 text-start hover:bg-surface-2"
                      onClick={() => onPick({ id: r.party.id, name: r.party.name })}
                    >
                      <span className="flex-1">
                        <span className="block font-semibold">{r.party.name}</span>
                        <span className="ltr block text-xs text-muted">{r.party.phone ?? '—'}</span>
                      </span>
                      {r.balance !== 0 ? (
                        <span className="text-end text-sm">
                          <span className="block text-xs text-muted">{t('customers.balance')}</span>
                          <Money
                            value={r.balance}
                            className={
                              r.balance > 0 ? 'font-semibold text-[var(--danger-ink)]' : ''
                            }
                          />
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
