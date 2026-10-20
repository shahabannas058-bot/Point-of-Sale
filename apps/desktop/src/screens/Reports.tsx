import { useMemo, useState, type ReactNode } from 'react';
import { Printer } from 'lucide-react';
import { PAYMENT_METHODS } from '@pos/shared';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { localDayRange, todayYmd } from '../lib/dates';
import { formatRs } from '../lib/money';
import { variantQtyText } from '../lib/qty';
import { printPage } from '../lib/print';
import { useServiceQuery } from '../service/use-query';
import { useCan } from '../store/session';

function Kpi({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone?: 'danger' | 'success';
  hint?: string;
}): ReactNode {
  return (
    <div className="card card-pad">
      <div className="panel-title">{label}</div>
      <Money
        value={value}
        className={`mt-1 block text-2xl font-bold xl:text-3xl ${tone === 'danger' ? 'text-[var(--danger-ink)]' : tone === 'success' ? 'text-[var(--success-ink)]' : ''}`}
      />
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

export function Reports(): ReactNode {
  const t = useT();
  const can = useCan();
  const [day, setDay] = useState(todayYmd());
  const range = useMemo(() => localDayRange(day), [day]);
  const q = useServiceQuery((s) => s.reports.summary(range), [range], can('view_reports'));

  if (!can('view_reports'))
    return <Empty title={t('err.FORBIDDEN')} hint={t('reports.forbiddenHint')} />;

  const s = q.data;
  const methodTotals = PAYMENT_METHODS.map((m) => ({ m, v: s?.byMethod[m] ?? 0 }));
  const maxAbs = Math.max(1, ...methodTotals.map((x) => Math.abs(x.v)));

  return (
    <div>
      <PageHeader
        title={t('nav.reports')}
        subtitle={t('reports.subtitle')}
        actions={
          <>
            <label className="field no-print">
              <span className="sr-only">{t('reports.date')}</span>
              <Input
                type="date"
                value={day}
                onChange={(e) => e.target.value && setDay(e.target.value)}
                className="ltr w-auto"
              />
            </label>
            <Button className="no-print" onClick={printPage}>
              <Printer size={16} aria-hidden="true" />
              {t('common.print')}
            </Button>
          </>
        }
      />

      {q.error ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : !s ? (
        <SkeletonRows rows={5} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi
              label={t('reports.netSales')}
              value={s.netRevenue}
              hint={t('reports.salesCount', { n: s.salesCount })}
            />
            <Kpi
              label={t('reports.returns')}
              value={s.returnsTotal}
              tone={s.returnsTotal > 0 ? 'danger' : undefined}
              hint={t('reports.returnsCount', { n: s.returnsCount })}
            />
            <Kpi label={t('reports.khataGiven')} value={s.byMethod.khata} />
            <Kpi label={t('reports.cashInDrawer')} value={s.cashInDrawer} tone="success" />
            {can('view_cost') ? (
              <Kpi
                label={t('reports.netProfit')}
                value={s.netProfit}
                tone={s.netProfit >= 0 ? 'success' : 'danger'}
                hint={t('reports.expensesHint', { amount: formatRs(s.expenses) })}
              />
            ) : null}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="card">
              <h2 className="border-b border-line px-4 py-3 text-base">
                {t('reports.paymentSplit')}
              </h2>
              <table className="tbl">
                <tbody>
                  {methodTotals.map(({ m, v }) => (
                    <tr key={m}>
                      <td className="w-40 font-medium">{t(dynKey('method', m))}</td>
                      <td>
                        <div
                          className="h-2.5 overflow-hidden rounded-full bg-surface-2"
                          aria-hidden="true"
                        >
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{
                              width: `${Math.round((Math.abs(v) / maxAbs) * 100)}%`,
                              opacity: v === 0 ? 0 : 1,
                            }}
                          />
                        </div>
                      </td>
                      <td className="num w-40">
                        <Money value={v} symbol={null} className="font-semibold" />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="font-medium">{t('reports.khataCollectedLabel')}</td>
                    <td />
                    <td className="num">
                      <Money value={s.khataCollected} symbol={null} className="font-semibold" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="card">
              <h2 className="border-b border-line px-4 py-3 text-base">{t('reports.summary')}</h2>
              <table className="tbl">
                <tbody>
                  {(
                    [
                      ['reports.gross', s.grossSales],
                      ['reports.discounts', s.discounts],
                      ['reports.netSalesOnly', s.netSales],
                      ['reports.returns', s.returnsTotal],
                      ['reports.netRevenue', s.netRevenue],
                    ] as const
                  ).map(([k, v]) => (
                    <tr key={k}>
                      <td className="font-medium">{t(k)}</td>
                      <td className="num">
                        <Money value={v} symbol={null} className="font-semibold" />
                      </td>
                    </tr>
                  ))}
                  {can('view_cost') ? (
                    <tr>
                      <td className="font-medium">{t('reports.cogs')}</td>
                      <td className="num">
                        <Money value={s.estimatedCogs} symbol={null} />
                      </td>
                    </tr>
                  ) : null}
                  {can('view_cost') ? (
                    <>
                      <tr>
                        <td className="font-medium">{t('reports.profit')}</td>
                        <td className="num">
                          <Money value={s.estimatedProfit} symbol={null} />
                        </td>
                      </tr>
                      <tr>
                        <td className="font-medium">{t('reports.expenses')}</td>
                        <td className="num">
                          <Money value={s.expenses} symbol={null} />
                        </td>
                      </tr>
                      <tr>
                        <td className="font-bold">{t('reports.netProfit')}</td>
                        <td className="num">
                          <Money value={s.netProfit} symbol={null} className="font-bold" />
                        </td>
                      </tr>
                    </>
                  ) : null}
                </tbody>
              </table>
            </section>
          </div>

          <section className="card">
            <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-base">
              {t('reports.lowStock')}{' '}
              <Badge tone={s.lowStock.length ? 'warning' : 'success'}>{s.lowStock.length}</Badge>
            </h2>
            {s.lowStock.length === 0 ? (
              <Empty title={t('inv.noLow')} hint={t('inv.noLowHint')} />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('inv.product')}</th>
                    <th>SKU</th>
                    <th className="num">{t('inv.stock')}</th>
                    <th className="num">{t('inv.reorder')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.lowStock.map((v) => (
                    <tr key={v.variant.id}>
                      <td className="font-semibold">{v.label}</td>
                      <td className="ltr font-mono text-xs">{v.variant.sku}</td>
                      <td className="num font-bold text-[var(--danger-ink)]">
                        {variantQtyText(v.onHand, v.variant)}
                      </td>
                      <td className="num">{variantQtyText(v.variant.reorderLevel, v.variant)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
