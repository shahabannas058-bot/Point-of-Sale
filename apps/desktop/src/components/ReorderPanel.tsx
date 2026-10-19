import { useState, type ReactNode } from 'react';
import { PackageCheck, Printer } from 'lucide-react';
import { useT } from '../i18n';
import { printPage } from '../lib/print';
import { useServiceQuery } from '../service/use-query';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Empty, ErrorBox, Money, SkeletonRows, Tabs } from './ui/misc';

type Window = '7' | '30' | '90';
/** Days of sales an order should cover on top of the reorder level. */
const COVER_DAYS = 14;

/** Purchase suggestion: what to reorder, how fast it sells and how much to buy. */
export function ReorderPanel(): ReactNode {
  const t = useT();
  const [win, setWin] = useState<Window>('30');
  const q = useServiceQuery(
    (s) => s.insights.reorder({ days: Number(win), coverDays: COVER_DAYS }),
    [win],
  );
  const rows = q.data ?? [];
  const toBuy = rows.filter((r) => r.suggestedQty > 0);
  const showCost = rows.some((r) => r.unitCost !== null);
  const estimate = toBuy.reduce((n, r) => n + r.suggestedQty * (r.unitCost ?? 0), 0);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">{t('reorder.window')}</span>
        <Tabs<Window>
          label={t('reorder.window')}
          value={win}
          onChange={setWin}
          items={(['7', '30', '90'] as const).map((d) => ({
            value: d,
            label: t('warranty.nDays', { n: d }),
          }))}
        />
        <span className="text-sm text-muted">{t('reorder.rule', { n: COVER_DAYS })}</span>
        <div className="ms-auto flex items-center gap-3">
          {showCost && toBuy.length > 0 ? (
            <span className="text-sm">
              {t('reorder.estimate')}: <Money value={estimate} className="font-bold" />
            </span>
          ) : null}
          <Button className="no-print" onClick={printPage} disabled={toBuy.length === 0}>
            <Printer size={16} aria-hidden="true" />
            {t('reorder.print')}
          </Button>
        </div>
      </div>

      {q.error ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : (
        <div className="tbl-wrap">
          {q.loading && !q.data ? (
            <SkeletonRows />
          ) : rows.length === 0 ? (
            <Empty
              icon={<PackageCheck size={26} aria-hidden="true" />}
              title={t('reorder.none')}
              hint={t('reorder.noneHint')}
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('inv.product')}</th>
                  <th className="num">{t('inv.stock')}</th>
                  <th className="num">{t('inv.reorder')}</th>
                  <th className="num">{t('reorder.sold', { n: win })}</th>
                  <th className="num">{t('reorder.perDay')}</th>
                  <th className="num">{t('reorder.daysLeft')}</th>
                  <th className="num">{t('reorder.suggested')}</th>
                  {showCost ? <th className="num">{t('reorder.cost')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.item.variant.id}>
                    <td>
                      <div className="font-medium">{r.item.label}</div>
                      <div className="ltr text-xs text-muted">{r.item.variant.sku}</div>
                    </td>
                    <td
                      className={`num font-semibold ${r.item.onHand <= 0 ? 'text-[var(--danger-ink)]' : ''}`}
                    >
                      {r.item.onHand}
                    </td>
                    <td className="num text-muted">{r.item.variant.reorderLevel}</td>
                    <td className="num">{r.sold}</td>
                    <td className="num">{r.dailyAvg.toFixed(2)}</td>
                    <td className="num">
                      {r.daysLeft === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <Badge
                          tone={r.daysLeft <= 3 ? 'danger' : r.daysLeft <= 7 ? 'warning' : 'muted'}
                        >
                          {t('warranty.nDays', { n: r.daysLeft })}
                        </Badge>
                      )}
                    </td>
                    <td className="num text-lg font-bold text-[var(--primary-ink)]">
                      {r.suggestedQty}
                    </td>
                    {showCost ? (
                      <td className="num">
                        {r.unitCost === null ? '—' : <Money value={r.suggestedQty * r.unitCost} />}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
