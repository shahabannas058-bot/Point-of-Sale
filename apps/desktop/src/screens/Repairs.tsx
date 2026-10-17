import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { AlarmClock, PackageCheck, Search, Wrench } from 'lucide-react';
import type { RepairStatus, RepairTicket } from '@pos/shared';
import { RepairIntakeDialog } from '../components/repairs/RepairIntakeDialog';
import { RepairStatusBadge, isClosed } from '../components/repairs/status';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows, Tabs } from '../components/ui/misc';
import { useT } from '../i18n';
import { formatDate } from '../lib/dates';
import { useServiceQuery } from '../service/use-query';

type View = 'open' | 'ready' | 'all' | 'delivered' | 'cancelled';

const STATUS_OF: Partial<Record<View, RepairStatus>> = {
  ready: 'ready',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

const isOverdue = (r: RepairTicket, now: number): boolean =>
  !isClosed(r.status) && r.status !== 'ready' && r.promisedAt !== null && r.promisedAt < now;

function StatTile({
  icon,
  label,
  value,
  tone,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card glass-i card-pad flex items-center gap-4 text-start"
    >
      <span
        className="grid size-12 shrink-0 place-items-center rounded-2xl"
        style={{ background: `var(--${tone}-soft)`, color: `var(--${tone}-ink)` }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span>
        <span className="panel-title block">{label}</span>
        <span className="num block text-3xl font-bold">{value}</span>
      </span>
    </button>
  );
}

export function Repairs(): ReactNode {
  const t = useT();
  const nav = useNavigate();
  const [view, setView] = useState<View>('open');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const status = STATUS_OF[view];
  const list = useServiceQuery(
    (s) =>
      s.repairs.list({
        q: q.trim() || undefined,
        status,
        openOnly: view === 'open' ? true : undefined,
        limit: 300,
      }),
    [q, view],
  );
  // counters come from one unfiltered open list so they do not change with the search box
  const openQ = useServiceQuery((s) => s.repairs.list({ openOnly: true, limit: 1000 }), []);
  const now = Date.now();
  const counts = useMemo(() => {
    const open = openQ.data ?? [];
    return {
      open: open.length,
      ready: open.filter((r) => r.status === 'ready').length,
      overdue: open.filter((r) => isOverdue(r, now)).length,
    };
  }, [openQ.data, now]);

  const open = (id: string): void => void nav(`/repairs/${id}`);

  return (
    <div>
      <PageHeader
        title={t('nav.repairs')}
        subtitle={t('repair.subtitle')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Wrench size={16} aria-hidden="true" />
            {t('repair.new')}
          </Button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          icon={<Wrench size={22} />}
          label={t('repair.statOpen')}
          value={counts.open}
          tone="primary"
          onClick={() => setView('open')}
        />
        <StatTile
          icon={<PackageCheck size={22} />}
          label={t('repair.statReady')}
          value={counts.ready}
          tone="success"
          onClick={() => setView('ready')}
        />
        <StatTile
          icon={<AlarmClock size={22} />}
          label={t('repair.statOverdue')}
          value={counts.overdue}
          tone="danger"
          onClick={() => setView('open')}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Tabs<View>
          label={t('repair.filter')}
          value={view}
          onChange={setView}
          items={[
            { value: 'open', label: t('repair.viewOpen') },
            { value: 'ready', label: t('repair.status.ready') },
            { value: 'delivered', label: t('repair.status.delivered') },
            { value: 'cancelled', label: t('repair.status.cancelled') },
            { value: 'all', label: t('common.all') },
          ]}
        />
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
            placeholder={t('repair.search')}
            aria-label={t('repair.search')}
          />
        </div>
      </div>

      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : (
        <div className="tbl-wrap">
          {list.loading && !list.data ? (
            <SkeletonRows />
          ) : (list.data ?? []).length === 0 ? (
            <Empty
              icon={<Wrench size={26} aria-hidden="true" />}
              title={t('repair.none')}
              hint={t('repair.noneHint')}
              action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  {t('repair.new')}
                </Button>
              }
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('repair.ticket')}</th>
                  <th>{t('billing.customer')}</th>
                  <th>{t('repair.device')}</th>
                  <th>{t('repair.problem')}</th>
                  <th>{t('repair.statusCol')}</th>
                  <th>{t('repair.promised')}</th>
                  <th className="num">{t('repair.estimate')}</th>
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => open(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') open(r.id);
                    }}
                  >
                    <td className="ltr font-semibold">{r.ticketNo}</td>
                    <td>
                      <div className="font-medium">{r.customerName}</div>
                      <div className="ltr text-xs text-muted">{r.customerPhone ?? ''}</div>
                    </td>
                    <td>
                      <div>
                        {r.deviceBrand} {r.deviceModel}
                      </div>
                      <div className="ltr num text-xs text-muted">{r.imei ?? r.serial ?? ''}</div>
                    </td>
                    <td className="max-w-64 truncate text-sm" title={r.problem}>
                      {r.problem}
                    </td>
                    <td>
                      <RepairStatusBadge status={r.status} />
                    </td>
                    <td className="ltr text-sm">
                      {r.promisedAt ? (
                        <span
                          className={
                            isOverdue(r, now) ? 'font-semibold text-[var(--danger-ink)]' : ''
                          }
                        >
                          {formatDate(r.promisedAt)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">
                      <Money value={r.finalCharge ?? r.estimatedCost} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <RepairIntakeDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(v) => {
          setCreating(false);
          open(v.ticket.id);
        }}
      />
    </div>
  );
}
