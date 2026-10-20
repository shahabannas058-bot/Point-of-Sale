import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Banknote,
  Boxes,
  ChevronRight,
  HandCoins,
  PackageX,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Empty, ErrorBox, Money, Tabs } from '../components/ui/misc';
import { BarList, ChartLegend, TrendChart } from '../components/dashboard/TrendChart';
import { dynKey, useT } from '../i18n';
import { formatDateTime, todayYmd } from '../lib/dates';
import { formatRs } from '../lib/money';
import { variantQtyText } from '../lib/qty';
import {
  DASH_PERIODS,
  OVERDUE_DAYS,
  periodBuckets,
  udhaarHealth,
  type DashPeriod,
} from '../lib/dashboard';
import { useServiceQuery } from '../service/use-query';
import { useShopModules } from '../service/use-modules';
import { useCan } from '../store/session';

const RECENT_SALES = 6;
const DAY_CHECK_MS = 60_000;

/** Today's local date, refreshed every minute so a screen left open overnight moves to the new day. */
function useToday(): string {
  const [day, setDay] = useState(todayYmd);
  useEffect(() => {
    const id = window.setInterval(() => setDay(todayYmd()), DAY_CHECK_MS);
    return () => window.clearInterval(id);
  }, []);
  return day;
}

/** Money, or a placeholder bar while the selected period is still loading. */
function Amt({ value, className }: { value: number | undefined; className?: string }): ReactNode {
  if (value === undefined)
    return <span className="skeleton inline-block h-[1em] w-24 align-middle" aria-hidden="true" />;
  return <Money value={value} {...(className ? { className } : {})} />;
}
const EXPIRY_WINDOW_DAYS = 7;

function Kpi({
  label,
  icon: Icon,
  children,
  hint,
}: {
  label: string;
  icon: LucideIcon;
  children: ReactNode;
  hint?: ReactNode;
}): ReactNode {
  return (
    <div className="card card-pad flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="panel-title uppercase">{label}</span>
        <span className="rounded-full bg-primary-soft p-1.5 text-[var(--primary-ink)]">
          <Icon size={15} aria-hidden="true" />
        </span>
      </div>
      <div className="text-xl font-bold xl:text-2xl">{children}</div>
      {hint ? <div className="text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={`card flex min-w-0 flex-col ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {subtitle ? <p className="text-xs text-muted">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      <div className="flex-1 p-4">{children}</div>
    </section>
  );
}

function MoreLink({ to, label }: { to: string; label: string }): ReactNode {
  return (
    <Link
      to={to}
      className="flex shrink-0 items-center gap-0.5 text-sm font-semibold text-[var(--primary-ink)] hover:underline"
    >
      {label}
      <ChevronRight size={14} aria-hidden="true" />
    </Link>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'danger' | 'success';
}): ReactNode {
  const ink =
    tone === 'danger'
      ? 'text-[var(--danger-ink)]'
      : tone === 'success'
        ? 'text-[var(--success-ink)]'
        : '';
  return (
    <div className="rounded-xl bg-surface-2/60 p-3">
      <div className="panel-title uppercase">{label}</div>
      <div className={`mt-1 text-lg font-bold ${ink}`}>{value}</div>
    </div>
  );
}

export function Dashboard(): ReactNode {
  const t = useT();
  const can = useCan();
  const modules = useShopModules();
  const allowed = can('view_reports');
  const seeCost = can('view_cost');
  const hasExpiry = modules.has('batch_expiry');
  const [period, setPeriod] = useState<DashPeriod>('month');
  const day = useToday();
  // `day` re-runs this after midnight so today stays the last point
  const { buckets, labels } = useMemo(() => periodBuckets(period, Date.now()), [period, day]);
  const range = useMemo(
    () => ({ fromMs: buckets[0] ?? 0, toMs: buckets[buckets.length - 1] ?? 0 }),
    [buckets],
  );

  const summary = useServiceQuery((s) => s.reports.summary(range), [range], allowed);
  const dash = useServiceQuery((s) => s.reports.dashboard({ buckets }), [buckets], allowed);
  const pending = useServiceQuery((s) => s.khata.pendingUdhaar(), [], allowed);
  const recent = useServiceQuery(
    (s) => s.checkout.listInvoices({ limit: RECENT_SALES }),
    [],
    allowed,
  );
  const expiring = useServiceQuery(
    (s) => s.batches.list({ withinDays: EXPIRY_WINDOW_DAYS }),
    [],
    allowed && hasExpiry,
  );

  if (!allowed) return <Empty title={t('err.FORBIDDEN')} hint={t('reports.forbiddenHint')} />;

  const error = summary.error ?? dash.error ?? pending.error ?? recent.error;
  // previous period's data stays in the query while the new one loads: never show it under the new heading
  const s =
    summary.data?.range.fromMs === range.fromMs && summary.data.range.toMs === range.toMs
      ? summary.data
      : undefined;
  const d =
    dash.data?.trend[0]?.fromMs === range.fromMs && dash.data.trend.length === labels.length
      ? dash.data
      : undefined;
  const health = udhaarHealth(pending.data ?? [], s?.khataCollected ?? 0);
  const outOfStock = s?.lowStock.filter((v) => v.onHand <= 0).length ?? 0;
  const lowOnly = (s?.lowStock.length ?? 0) - outOfStock;
  const series = [
    {
      key: 'revenue',
      label: t('dash.revenue'),
      color: 'var(--chart-1)',
      values: d?.trend.map((p) => p.revenue) ?? [],
    },
    ...(seeCost
      ? [
          {
            key: 'profit',
            label: t('dash.grossProfit'),
            color: 'var(--chart-2)',
            values: d?.trend.map((p) => p.profit) ?? [],
          },
        ]
      : []),
  ];
  const periodLabel = t(dynKey('dash.period', period));
  const loading = !s || !d;

  return (
    <div className="flex flex-col gap-4">
      <header className="card card-pad flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--primary-ink)]">
            {t('dash.eyebrow')}
          </div>
          <h1 className="display mt-1 text-3xl">{t('nav.dashboard')}</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">{t('dash.subtitle')}</p>
        </div>
        <Tabs
          value={period}
          onChange={setPeriod}
          label={t('dash.periodLabel')}
          items={DASH_PERIODS.map((p) => ({ value: p, label: t(dynKey('dash.tab', p)) }))}
        />
      </header>

      {error ? (
        <ErrorBox
          error={error}
          onRetry={() => {
            summary.reload();
            dash.reload();
            pending.reload();
            recent.reload();
          }}
        />
      ) : null}

      <div
        className={`flex flex-col gap-4 transition-opacity ${summary.loading || dash.loading ? 'opacity-70' : ''}`}
        aria-busy={loading}
      >
        <h2 className="panel-title uppercase tracking-[0.15em]">
          {t('dash.performance', { period: periodLabel })}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <Kpi
            label={t('dash.sales')}
            icon={Banknote}
            hint={t('reports.salesCount', { n: s?.salesCount ?? 0 })}
          >
            <Amt value={s?.netRevenue} />
          </Kpi>
          {seeCost ? (
            <Kpi label={t('dash.grossProfit')} icon={TrendingUp} hint={t('reports.profitHint')}>
              <Amt value={s?.estimatedProfit} />
            </Kpi>
          ) : null}
          {seeCost ? (
            <Kpi
              label={t('reports.netProfit')}
              icon={Wallet}
              hint={t('reports.expensesHint', { amount: formatRs(s?.expenses ?? 0) })}
            >
              <Amt
                value={s?.netProfit}
                className={(s?.netProfit ?? 0) < 0 ? 'text-[var(--danger-ink)]' : ''}
              />
            </Kpi>
          ) : null}
          {seeCost ? (
            <Kpi label={t('dash.inventoryValue')} icon={Boxes} hint={t('dash.atCost')}>
              <Amt value={d?.inventoryValue} />
            </Kpi>
          ) : null}
          <Kpi
            label={t('udhaar.pending')}
            icon={HandCoins}
            hint={t('dash.customersOwing', { n: health.customers })}
          >
            <Money value={health.outstanding} />
          </Kpi>
          <Kpi
            label={t('reports.lowStock')}
            icon={PackageX}
            hint={t('dash.outOfStock', { n: outOfStock })}
          >
            <span className="num">{s?.lowStock.length ?? 0}</span>
          </Kpi>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <Panel
            className="xl:col-span-2"
            title={t('dash.salesTrend')}
            subtitle={t('dash.salesTrendHint')}
            action={series.length > 1 ? <ChartLegend items={series} /> : null}
          >
            <TrendChart
              labels={labels}
              series={series}
              ariaLabel={t('dash.salesTrendAria', { period: periodLabel })}
            />
          </Panel>
          <Panel title={t('dash.profitSnapshot')} subtitle={t('dash.profitSnapshotHint')}>
            <div className="grid grid-cols-2 gap-3">
              <Stat label={t('dash.revenue')} value={<Amt value={s?.netRevenue} />} />
              {seeCost ? (
                <Stat
                  label={t('dash.net')}
                  value={<Amt value={s?.netProfit} />}
                  tone={(s?.netProfit ?? 0) < 0 ? 'danger' : 'success'}
                />
              ) : null}
            </div>
            <div className="mt-4">
              <BarList
                rows={[
                  { key: 'rev', label: t('dash.revenue'), value: s?.netRevenue ?? 0 },
                  ...(seeCost
                    ? [
                        { key: 'cogs', label: t('reports.cogs'), value: s?.estimatedCogs ?? 0 },
                        { key: 'exp', label: t('reports.expenses'), value: s?.expenses ?? 0 },
                        { key: 'net', label: t('reports.netProfit'), value: s?.netProfit ?? 0 },
                      ]
                    : [{ key: 'disc', label: t('reports.discounts'), value: s?.discounts ?? 0 }]),
                ]}
              />
            </div>
          </Panel>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title={t('dash.inventoryHealth')}
            subtitle={t('dash.inventoryHealthHint')}
            action={<MoreLink to="/inventory" label={t('nav.inventory')} />}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              {seeCost ? (
                <div>
                  <Amt value={d?.inventoryValue} className="text-2xl font-bold" />
                  <div className="text-xs text-muted">{t('dash.inventoryValueHint')}</div>
                </div>
              ) : null}
              <ul className="flex flex-col gap-1.5 text-sm">
                <li className="flex items-center gap-2">
                  <Badge tone={lowOnly ? 'warning' : 'success'}>{lowOnly}</Badge>
                  {t('dash.lowStockItems')}
                </li>
                <li className="flex items-center gap-2">
                  <Badge tone={outOfStock ? 'danger' : 'success'}>{outOfStock}</Badge>
                  {t('dash.outOfStockItems')}
                </li>
                {hasExpiry ? (
                  <li className="flex items-center gap-2">
                    <Badge tone={expiring.data?.length ? 'warning' : 'success'}>
                      {expiring.data?.length ?? 0}
                    </Badge>
                    <Link to="/expiry" className="hover:underline">
                      {t('dash.expiringSoon', { n: EXPIRY_WINDOW_DAYS })}
                    </Link>
                  </li>
                ) : null}
              </ul>
            </div>
            {s && s.lowStock.length > 0 ? (
              <ul className="mt-4 divide-y divide-[var(--border)] border-t border-line text-sm">
                {s.lowStock.slice(0, 4).map((v) => (
                  <li key={v.variant.id} className="flex justify-between gap-3 py-2">
                    <span className="truncate">{v.label}</span>
                    <span
                      className={`num shrink-0 font-semibold ${v.onHand <= 0 ? 'text-[var(--danger-ink)]' : 'text-[var(--warning-ink)]'}`}
                    >
                      {v.onHand <= 0
                        ? t('dash.out')
                        : t('dash.left', { qty: variantQtyText(v.onHand, v.variant) })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>

          <Panel
            title={t('dash.customerPayments')}
            subtitle={t('dash.customerPaymentsHint')}
            action={<MoreLink to="/customers/pending" label={t('udhaar.pending')} />}
          >
            <div className="grid grid-cols-2 gap-3">
              <Stat label={t('dash.outstanding')} value={<Money value={health.outstanding} />} />
              <Stat
                label={t('dash.overdue', { n: OVERDUE_DAYS })}
                value={<Money value={health.overdue} />}
                tone={health.overdue > 0 ? 'danger' : undefined}
              />
              <Stat
                label={t('dash.collected')}
                value={<Money value={health.collected} />}
                tone="success"
              />
              <Stat label={t('dash.givenOnUdhaar')} value={<Amt value={s?.byMethod.khata} />} />
            </div>
            <div className="mt-4">
              <div className="mb-1 flex justify-between text-sm">
                <span>{t('dash.collectionRate')}</span>
                <span className="num font-semibold">
                  {Math.round(health.collectionRate * 100)}%
                </span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-surface-2"
                role="meter"
                aria-label={t('dash.collectionRate')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(health.collectionRate * 100)}
              >
                <div
                  className="h-full rounded-full bg-[var(--chart-1)]"
                  style={{ width: `${Math.round(health.collectionRate * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-muted">
                {health.overdueCustomers > 0
                  ? t('dash.overdueHint', { n: health.overdueCustomers, days: OVERDUE_DAYS })
                  : t('dash.noOverdue')}
              </p>
            </div>
          </Panel>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title={t('dash.topCategories')} subtitle={t('dash.topCategoriesHint')}>
            {d && d.topCategories.length > 0 ? (
              <BarList
                rows={d.topCategories.map((c) => ({
                  key: c.category,
                  label: c.category || t('dash.uncategorised'),
                  value: c.revenue,
                }))}
              />
            ) : (
              <Empty title={t('dash.noCategorySales')} />
            )}
          </Panel>

          <Panel
            title={t('dash.recentSales')}
            subtitle={t('dash.recentSalesHint')}
            action={<MoreLink to="/sales" label={t('dash.viewAll')} />}
          >
            {recent.data && recent.data.length > 0 ? (
              <ul className="-my-2 divide-y divide-[var(--border)]">
                {recent.data.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="ltr font-mono text-sm font-semibold">{i.invoiceNo}</span>
                        {i.kind !== 'sale' ? (
                          <Badge tone={i.kind === 'return' ? 'warning' : 'danger'}>
                            {t(dynKey('kind', i.kind))}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="truncate text-xs text-muted">
                        {i.customerName ?? t('billing.walkIn')} · {formatDateTime(i.createdAt)}
                      </div>
                    </div>
                    <Money value={i.total} className="shrink-0 font-semibold" />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title={t('dash.noRecentSales')} />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
