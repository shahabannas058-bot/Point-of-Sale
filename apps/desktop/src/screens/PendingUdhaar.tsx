import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, FileText, MessageCircle, Wallet } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows } from '../components/ui/misc';
import { useT } from '../i18n';
import { daysSince, formatDate, monthYm } from '../lib/dates';
import { reminderLink } from '../lib/udhaar-reminder';
import { useServiceQuery } from '../service/use-query';

/** A customer is "overdue" after this many days without a payment. */
export const OVERDUE_DAYS = 30;

/** Everyone who owes udhaar, biggest first, with a WhatsApp reminder and a statement link per row. */
export function PendingUdhaar(): ReactNode {
  const t = useT();
  const [overdueOnly, setOverdueOnly] = useState(false);
  const q = useServiceQuery((s) => s.khata.pendingUdhaar(), []);
  const shop = useServiceQuery((s) => s.setup.getShop(), []);
  const now = Date.now();

  const rows = (q.data ?? []).map((r) => {
    const since = r.lastPaymentAt ?? r.lastCreditAt;
    return { ...r, days: since === null ? null : daysSince(since, now) };
  });
  const shown = overdueOnly ? rows.filter((r) => r.days !== null && r.days >= OVERDUE_DAYS) : rows;
  const total = shown.reduce((a, r) => a + r.balance, 0);

  return (
    <div>
      <div className="no-print mb-2">
        <Link
          to="/customers"
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary-ink"
        >
          <ArrowLeft size={16} className="rtl:-scale-x-100" aria-hidden="true" />
          {t('nav.customers')}
        </Link>
      </div>
      <PageHeader title={t('udhaar.pending')} subtitle={t('udhaar.pendingSubtitle')} />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card card-pad">
          <div className="panel-title flex items-center gap-2">
            <Wallet size={14} aria-hidden="true" />
            {t('udhaar.total')}
          </div>
          <Money value={total} className="mt-1 block text-3xl font-bold text-[var(--danger-ink)]" />
        </div>
        <div className="card card-pad">
          <div className="panel-title">{t('customers.owing')}</div>
          <div className="num mt-1 text-3xl font-bold">{shown.length}</div>
        </div>
      </div>

      <div className="no-print mb-3 flex flex-wrap items-center gap-3">
        <label className="check">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
          />
          {t('udhaar.olderThan')}
        </label>
      </div>

      {q.error ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : (
        <div className="tbl-wrap">
          {q.loading && !q.data ? (
            <SkeletonRows />
          ) : shown.length === 0 ? (
            <Empty title={t('udhaar.nonePending')} />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('customers.name')}</th>
                  <th>{t('customers.phone')}</th>
                  <th>{t('udhaar.lastGiven')}</th>
                  <th>{t('udhaar.lastPaid')}</th>
                  <th className="num">{t('udhaar.daysNoPayment')}</th>
                  <th className="num">{t('customers.balance')}</th>
                  <th className="no-print">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const wa = shop.data
                    ? reminderLink(t, {
                        name: r.party.name,
                        phone: r.party.phone,
                        balance: r.balance,
                        shopName: shop.data.shopName,
                        now,
                      })
                    : null;
                  return (
                    <tr key={r.party.id}>
                      <td className="font-semibold">
                        <Link to={`/customers/${r.party.id}`} className="hover:underline">
                          {r.party.name}
                        </Link>
                      </td>
                      <td className="ltr text-sm">{r.party.phone ?? '—'}</td>
                      <td className="ltr text-sm">
                        {r.lastCreditAt === null ? '—' : formatDate(r.lastCreditAt)}
                      </td>
                      <td className="ltr text-sm">
                        {r.lastPaymentAt === null ? (
                          <span className="text-muted">{t('udhaar.never')}</span>
                        ) : (
                          formatDate(r.lastPaymentAt)
                        )}
                      </td>
                      <td className="num">
                        {r.days === null ? (
                          '—'
                        ) : (
                          <Badge tone={r.days >= OVERDUE_DAYS ? 'warning' : 'muted'}>
                            {t('udhaar.days', { n: r.days })}
                          </Badge>
                        )}
                      </td>
                      <td className="num">
                        <Money value={r.balance} className="font-bold text-[var(--danger-ink)]" />
                      </td>
                      <td className="no-print">
                        <div className="flex items-center gap-1">
                          {wa ? (
                            <a
                              className="btn btn-success btn-sm"
                              href={wa}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`${t('udhaar.whatsapp')}: ${r.party.name}`}
                            >
                              <MessageCircle size={14} aria-hidden="true" />
                              WhatsApp
                            </a>
                          ) : (
                            <span
                              className="btn btn-sm opacity-50"
                              aria-disabled="true"
                              title={t('udhaar.noPhone')}
                            >
                              <MessageCircle size={14} aria-hidden="true" />
                              WhatsApp
                            </span>
                          )}
                          <Link
                            className="btn btn-sm"
                            to={`/customers/${r.party.id}/statement?m=${monthYm(now)}`}
                          >
                            <FileText size={14} aria-hidden="true" />
                            {t('udhaar.openStatement')}
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
