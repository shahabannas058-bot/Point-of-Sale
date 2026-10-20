import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, ChevronLeft, ChevronRight, History } from 'lucide-react';
import type { StockLogEntry, StockLogPage } from '@pos/shared';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { Empty, ErrorBox, PageHeader, SkeletonRows } from '../components/ui/misc';
import { useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { formatDateTime, localMonthRange, monthYm, shiftMonth } from '../lib/dates';
import { signedQtyText } from '../lib/item-history';
import { qtyText } from '../lib/qty';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useCan } from '../store/session';
import { toast } from '../store/toast';

const YM = /^\d{4}-\d{2}$/;
const PAGE = 100;

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }): ReactNode {
  return (
    <div className="card p-4">
      <div className="panel-title">{label}</div>
      <div className={`num mt-1 text-2xl font-bold ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

function Row({ e }: { e: StockLogEntry }): ReactNode {
  const t = useT();
  const qty = (n: number): string => qtyText(n, e.unitScale, e.unitLabel);
  return (
    <tr>
      <td data-label={t('sales.date')} className="whitespace-nowrap">
        {formatDateTime(e.at)}
      </td>
      <td data-label={t('billing.item')} className="font-medium">
        {e.label}
      </td>
      <td data-label={t('hist.by')}>{e.by.displayName}</td>
      <td data-label={t('adjlog.before')} className="num ltr">
        {qty(e.balanceBefore)}
      </td>
      <td data-label={t('adjlog.change')} className="num ltr">
        <Badge tone={e.quantity > 0 ? 'success' : 'danger'}>
          {signedQtyText(e.quantity, e.unitScale, e.unitLabel)}
        </Badge>
      </td>
      <td data-label={t('adjlog.after')} className="num ltr font-semibold">
        {qty(e.balanceAfter)}
      </td>
      <td data-label={t('adjlog.reason')}>
        {e.repair ? (
          <Link to={`/repairs/${e.repair.ticketId}`} className="font-semibold text-primary-ink">
            {t('adjlog.repair', { no: e.repair.ticketNo })}
          </Link>
        ) : (
          (e.reason ?? '—')
        )}
        {e.batch ? (
          <span className="ltr block text-xs text-muted">
            {e.batch.batchNo ?? ''} · {t('hist.exp')} {e.batch.expiryDate}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/** Every hand-made stock change for the owner / manager, month by month, so missing stock can be traced. */
export function StockLog(): ReactNode {
  const t = useT();
  const can = useCan();
  const service = useService();
  const [ym, setYm] = useState(monthYm());
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [older, setOlder] = useState<{
    entries: StockLogEntry[];
    next: StockLogPage['nextBefore'];
  }>({ entries: [], next: null });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setTerm(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  const range = localMonthRange(ym);
  const query = { from: range.fromMs, to: range.toMs, limit: PAGE, ...(term ? { q: term } : {}) };
  const allowed = can('view_reports');
  const page = useServiceQuery((s) => s.reports.adjustments(query), [ym, term], allowed);
  // a new first page (filter change or any write) drops the pages loaded with "Load older"
  useEffect(() => setOlder({ entries: [], next: null }), [page.data]);
  // a "Load older" answer for a month / search the screen has since left is thrown away
  const queryKey = `${ym}|${term}`;
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;

  if (!allowed) return <ErrorBox error={new Error(t('err.FORBIDDEN'))} />;

  const data = page.data;
  const entries = [...(data?.entries ?? []), ...older.entries];
  const next = older.entries.length > 0 ? older.next : (data?.nextBefore ?? null);

  const loadMore = async (): Promise<void> => {
    if (!next || page.loading) return;
    const key = queryKey;
    setLoadingMore(true);
    try {
      const more = await service.reports.adjustments({ ...query, before: next });
      if (keyRef.current !== key) return;
      setOlder((o) => ({ entries: [...o.entries, ...more.entries], next: more.nextBefore }));
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          to="/inventory"
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary-ink"
        >
          <ArrowLeft size={16} className="rtl:-scale-x-100" aria-hidden="true" />
          {t('nav.inventory')}
        </Link>
      </div>
      <PageHeader
        title={t('adjlog.title')}
        subtitle={t('adjlog.subtitle')}
        actions={
          <div className="flex items-center gap-1">
            <Button
              icon
              aria-label={t('udhaar.prevMonth')}
              onClick={() => setYm(shiftMonth(ym, -1))}
            >
              <ChevronLeft size={16} className="rtl:-scale-x-100" aria-hidden="true" />
            </Button>
            <label className="field">
              <span className="sr-only">{t('udhaar.month')}</span>
              <Input
                type="month"
                value={ym}
                onChange={(e) => YM.test(e.target.value) && setYm(e.target.value)}
                className="ltr w-auto"
              />
            </label>
            <Button
              icon
              aria-label={t('udhaar.nextMonth')}
              disabled={ym >= monthYm()}
              onClick={() => setYm(shiftMonth(ym, 1))}
            >
              <ChevronRight size={16} className="rtl:-scale-x-100" aria-hidden="true" />
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label={t('adjlog.count')} value={data?.summary.count ?? 0} />
        <Kpi
          label={t('adjlog.increases')}
          value={data?.summary.increases ?? 0}
          tone="text-success"
        />
        <Kpi
          label={t('adjlog.decreases')}
          value={data?.summary.decreases ?? 0}
          tone="text-danger"
        />
      </div>

      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('adjlog.search')}
        aria-label={t('adjlog.search')}
        inputMode="search"
        autoComplete="off"
      />

      {page.error ? <ErrorBox error={page.error} onRetry={page.reload} /> : null}
      <div className="tbl-wrap">
        {data === undefined ? (
          <SkeletonRows />
        ) : entries.length === 0 ? (
          <Empty
            icon={<History size={28} aria-hidden="true" />}
            title={t('adjlog.empty')}
            hint={t('adjlog.emptyHint')}
          />
        ) : (
          <table className="tbl tbl-cards">
            <thead>
              <tr>
                <th>{t('sales.date')}</th>
                <th>{t('billing.item')}</th>
                <th>{t('hist.by')}</th>
                <th className="num">{t('adjlog.before')}</th>
                <th className="num">{t('adjlog.change')}</th>
                <th className="num">{t('adjlog.after')}</th>
                <th>{t('adjlog.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <Row key={e.id} e={e} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {next ? (
        <Button
          className="self-center"
          loading={loadingMore}
          disabled={page.loading}
          onClick={() => void loadMore()}
        >
          {t('hist.loadOlder')}
        </Button>
      ) : null}
    </div>
  );
}
