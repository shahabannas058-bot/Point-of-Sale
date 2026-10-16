import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Search, UserPlus, Wallet } from 'lucide-react';
import { CustomerForm } from '../components/CustomerPicker';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Input } from '../components/ui/Field';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows } from '../components/ui/misc';
import { Badge } from '../components/ui/Badge';
import { useT } from '../i18n';
import { formatDate } from '../lib/dates';
import { useServiceQuery } from '../service/use-query';

export function Customers(): ReactNode {
  const t = useT();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [owingOnly, setOwingOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const list = useServiceQuery(
    (s) => s.khata.listCustomers({ q, withBalanceOnly: owingOnly }),
    [q, owingOnly],
  );
  const totals = useServiceQuery((s) => s.khata.totals(), []);

  return (
    <div>
      <PageHeader
        title={t('nav.customers')}
        subtitle={t('customers.subtitle')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <UserPlus size={16} aria-hidden="true" />
            {t('customers.new')}
          </Button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card card-pad">
          <div className="panel-title flex items-center gap-2">
            <Wallet size={14} aria-hidden="true" />
            {t('customers.receivable')}
          </div>
          <Money
            value={totals.data?.receivable ?? 0}
            className="mt-1 block text-3xl font-bold text-[var(--danger-ink)]"
          />
        </div>
        <div className="card card-pad">
          <div className="panel-title">{t('customers.owing')}</div>
          <div className="num mt-1 text-3xl font-bold">{totals.data?.customersOwing ?? 0}</div>
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
            placeholder={t('customers.searchPlaceholder')}
            aria-label={t('customers.searchPlaceholder')}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={owingOnly}
            onChange={(e) => setOwingOnly(e.target.checked)}
          />
          {t('customers.onlyOwing')}
        </label>
      </div>

      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : (
        <div className="tbl-wrap">
          {list.loading && !list.data ? (
            <SkeletonRows />
          ) : (list.data ?? []).length === 0 ? (
            <Empty title={t('customers.none')} hint={t('customers.noneHint')} />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('customers.name')}</th>
                  <th>{t('customers.phone')}</th>
                  <th className="num">{t('customers.creditLimit')}</th>
                  <th>{t('customers.lastActivity')}</th>
                  <th className="num">{t('customers.balance')}</th>
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((r) => (
                  <tr
                    key={r.party.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => void nav(`/customers/${r.party.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void nav(`/customers/${r.party.id}`);
                    }}
                  >
                    <td className="font-semibold">{r.party.name}</td>
                    <td className="ltr text-sm">{r.party.phone ?? '—'}</td>
                    <td className="num">
                      {r.party.creditLimit !== null ? (
                        <Money value={r.party.creditLimit} symbol={null} />
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="ltr text-sm">
                      {r.lastActivityAt ? formatDate(r.lastActivityAt) : '—'}
                    </td>
                    <td className="num">
                      {r.balance > 0 ? (
                        <Money value={r.balance} className="font-bold text-[var(--danger-ink)]" />
                      ) : r.balance < 0 ? (
                        <Badge tone="success">
                          {t('customers.advance')} <Money value={Math.abs(r.balance)} />
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
        width={560}
        title={t('customers.new')}
      >
        <CustomerForm
          onCancel={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            void nav(`/customers/${c.id}`);
          }}
        />
      </Dialog>
    </div>
  );
}
