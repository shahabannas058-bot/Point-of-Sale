import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { useT } from '../i18n';
import { formatDate } from '../lib/dates';
import { useServiceQuery } from '../service/use-query';
import type { CartLine } from '../store/cart';
import { Money } from './ui/misc';

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="m-0 text-end font-semibold">{children}</dd>
    </div>
  );
}

/** Counter info for the selected bill line: stock, last purchase cost, last rate to this customer, 30-day sales. */
export function TillInfo({
  line,
  customerId,
}: {
  line: CartLine | undefined;
  customerId: string | null;
}): ReactNode {
  const t = useT();
  const q = useServiceQuery(
    (s) =>
      s.insights.item({
        variantId: line?.variantId,
        phoneUnitId: line?.phoneUnitId,
        customerId,
      }),
    [line?.variantId, line?.phoneUnitId, customerId],
    line !== undefined,
  );
  if (!line) return null;
  const d = q.data;

  return (
    <section className="card card-pad" aria-label={t('till.title')} aria-live="polite">
      <div className="panel-title mb-1 flex items-center gap-2">
        <Info size={14} aria-hidden="true" />
        {t('till.title')}
        <span className="ms-auto truncate font-normal normal-case" title={line.label}>
          {line.label}
        </span>
      </div>
      {q.error ? (
        <div className="text-sm text-[var(--danger-ink)]">{t('till.unavailable')}</div>
      ) : !d ? (
        <div className="skeleton h-20" aria-hidden="true" />
      ) : (
        <dl className="m-0">
          <Row label={t('till.stock')}>
            <span className={`num ${d.onHand <= 0 ? 'text-[var(--danger-ink)]' : ''}`}>
              {line.kind === 'phone' ? (d.onHand > 0 ? t('inv.inStock') : t('inv.sold')) : d.onHand}
            </span>
          </Row>
          {d.lastPurchase ? (
            <Row label={t('till.lastCost')}>
              <Money value={d.lastPurchase.unitCost} />
              <span className="ltr ms-2 text-xs font-normal text-muted">
                {formatDate(d.lastPurchase.at)}
              </span>
            </Row>
          ) : null}
          {customerId ? (
            <Row label={t('till.lastRate')}>
              {d.lastSoldToCustomer ? (
                <>
                  <Money value={d.lastSoldToCustomer.unitPrice} />
                  <span className="ltr ms-2 text-xs font-normal text-muted">
                    {formatDate(d.lastSoldToCustomer.at)} · {d.lastSoldToCustomer.invoiceNo}
                  </span>
                </>
              ) : (
                <span className="font-normal text-muted">{t('till.neverSold')}</span>
              )}
            </Row>
          ) : null}
          <Row label={t('till.sold30')}>
            <span className="num">{d.soldLast30Days}</span>
          </Row>
        </dl>
      )}
    </section>
  );
}
