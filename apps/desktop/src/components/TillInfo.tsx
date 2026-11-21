import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { useT } from '../i18n';
import { formatDate } from '../lib/dates';
import { qtyText } from '../lib/qty';
import { useServiceQuery } from '../service/use-query';
import { lineScale, type CartLine } from '../store/cart';
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
  // only ask once there is a real item id: an empty id must never reach the service
  const itemId = line?.itemId ? line.itemId : null;
  const q = useServiceQuery(
    (s) => (itemId === null ? Promise.resolve(null) : s.insights.item({ itemId, customerId })),
    [itemId, customerId],
    itemId !== null,
  );
  if (!line) return null;
  const d = q.data;
  const qty = (n: number): string => qtyText(n, lineScale(line), line.unitLabel);

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
              {qty(d.onHand)}
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
            <span className="num">{qty(d.soldLast30Days)}</span>
          </Row>
        </dl>
      )}
    </section>
  );
}
