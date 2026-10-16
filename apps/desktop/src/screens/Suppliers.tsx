import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Search, Truck, Wallet } from 'lucide-react';
import type { Supplier } from '@pos/shared';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input } from '../components/ui/Field';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows } from '../components/ui/misc';
import { useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { formatDate } from '../lib/dates';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { toast } from '../store/toast';

function SupplierForm({
  onCreated,
  onCancel,
}: {
  onCreated: (s: Supplier) => void;
  onCancel: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [f, setF] = useState({ name: '', phone: '', address: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (): Promise<void> => {
    if (!f.name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const s = await service.purchasing.createSupplier({
        name: f.name.trim(),
        phone: f.phone.trim() || null,
        address: f.address.trim() || null,
      });
      bump();
      toast.success(t('suppliers.created'));
      onCreated(s);
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
      <Field label={t('suppliers.name')}>
        <Input value={f.name} onChange={set('name')} data-autofocus required />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('suppliers.phone')}>
          <Input value={f.phone} onChange={set('phone')} inputMode="tel" className="ltr" />
        </Field>
        <Field label={t('suppliers.address')}>
          <Input value={f.address} onChange={set('address')} />
        </Field>
      </div>
      {err ? (
        <div role="alert" className="text-sm font-medium text-[var(--danger-ink)]">
          {err}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!f.name.trim()} loading={busy}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

export function Suppliers(): ReactNode {
  const t = useT();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [owedOnly, setOwedOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const list = useServiceQuery((s) => s.purchasing.listSuppliers(), []);
  const totals = useServiceQuery((s) => s.purchasing.totals(), []);

  const needle = q.trim().toLowerCase();
  const rows = (list.data ?? []).filter(
    (r) =>
      (!owedOnly || r.balance > 0) &&
      (needle === '' ||
        r.party.name.toLowerCase().includes(needle) ||
        (r.party.phone ?? '').includes(needle)),
  );

  return (
    <div>
      <PageHeader
        title={t('nav.suppliers')}
        subtitle={t('suppliers.subtitle')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Truck size={16} aria-hidden="true" />
            {t('suppliers.new')}
          </Button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card card-pad">
          <div className="panel-title flex items-center gap-2">
            <Wallet size={14} aria-hidden="true" />
            {t('suppliers.payable')}
          </div>
          <Money
            value={totals.data?.payable ?? 0}
            className="mt-1 block text-3xl font-bold text-[var(--danger-ink)]"
          />
        </div>
        <div className="card card-pad">
          <div className="panel-title">{t('suppliers.owed')}</div>
          <div className="num mt-1 text-3xl font-bold">{totals.data?.suppliersOwed ?? 0}</div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
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
            placeholder={t('suppliers.searchPlaceholder')}
            aria-label={t('suppliers.searchPlaceholder')}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={owedOnly}
            onChange={(e) => setOwedOnly(e.target.checked)}
          />
          {t('suppliers.onlyOwed')}
        </label>
      </div>

      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : (
        <div className="tbl-wrap">
          {list.loading && !list.data ? (
            <SkeletonRows />
          ) : rows.length === 0 ? (
            <Empty title={t('suppliers.none')} hint={t('suppliers.noneHint')} />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('suppliers.name')}</th>
                  <th>{t('suppliers.phone')}</th>
                  <th>{t('suppliers.lastActivity')}</th>
                  <th className="num">{t('suppliers.balance')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.party.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => void nav(`/suppliers/${r.party.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void nav(`/suppliers/${r.party.id}`);
                    }}
                  >
                    <td className="font-semibold">{r.party.name}</td>
                    <td className="ltr text-sm">{r.party.phone ?? '—'}</td>
                    <td className="ltr text-sm">
                      {r.lastActivityAt ? formatDate(r.lastActivityAt) : '—'}
                    </td>
                    <td className="num">
                      {r.balance > 0 ? (
                        <Money value={r.balance} className="font-bold text-[var(--danger-ink)]" />
                      ) : r.balance < 0 ? (
                        <Badge tone="success">
                          {t('suppliers.advance')} <Money value={Math.abs(r.balance)} />
                        </Badge>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        width={520}
        title={t('suppliers.new')}
      >
        <SupplierForm
          onCancel={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            void nav(`/suppliers/${s.id}`);
          }}
        />
      </Dialog>
    </div>
  );
}
