import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, ChevronLeft, ChevronRight, MessageCircle, Printer } from 'lucide-react';
import { ReceiptDialog } from '../components/ReceiptDialog';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { formatDateTime, formatMonth, localMonthRange, monthYm, shiftMonth } from '../lib/dates';
import { printPage } from '../lib/print';
import { reminderLink } from '../lib/udhaar-reminder';
import { useServiceQuery } from '../service/use-query';

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

/** One customer's udhaar for one month: opening balance, every entry, closing balance; printable; WhatsApp reminder. */
export function CustomerStatement(): ReactNode {
  const t = useT();
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const raw = params.get('m') ?? '';
  const ym = YM.test(raw) ? raw : monthYm();
  const setYm = (next: string): void => setParams({ m: next });
  const range = useMemo(() => localMonthRange(ym), [ym]);
  const q = useServiceQuery((s) => s.khata.statement(id, range), [id, range]);
  const shop = useServiceQuery((s) => s.setup.getShop(), []);
  const [receipt, setReceipt] = useState<string | null>(null);
  const data = q.data;

  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!data) return <SkeletonRows rows={8} />;
  const c = data.customer;
  const typeLabel = (type: string): string => t(dynKey('ledger', type, 'ledger.adjustment'));
  // the reminder quotes the balance "as of today", so it is only offered when the viewed month runs to now
  const isCurrent = range.toMs > Date.now();
  const wa =
    data.closing > 0 && isCurrent && shop.data
      ? reminderLink(t, {
          name: c.name,
          phone: c.phone,
          balance: data.closing,
          shopName: shop.data.shopName,
        })
      : null;

  return (
    <div>
      <div className="no-print mb-2">
        <Link
          to={`/customers/${id}`}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary-ink"
        >
          <ArrowLeft size={16} className="rtl:-scale-x-100" aria-hidden="true" />
          {c.name}
        </Link>
      </div>
      <PageHeader
        title={`${t('udhaar.statement')} · ${formatMonth(ym)}`}
        subtitle={
          <span>
            {t('udhaar.statementSubtitle', { name: c.name })}
            {c.phone ? <span className="ltr"> · {c.phone}</span> : null}
          </span>
        }
        actions={
          <>
            <div className="no-print flex items-center gap-1">
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
                onClick={() => setYm(shiftMonth(ym, 1))}
              >
                <ChevronRight size={16} className="rtl:-scale-x-100" aria-hidden="true" />
              </Button>
            </div>
            <Button className="no-print" onClick={printPage}>
              <Printer size={16} aria-hidden="true" />
              {t('common.print')}
            </Button>
            {wa ? (
              <a
                className="btn btn-success no-print"
                href={wa}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MessageCircle size={16} aria-hidden="true" />
                {t('udhaar.whatsapp')}
              </a>
            ) : data.closing > 0 && isCurrent ? (
              <Button className="no-print" disabled title={t('udhaar.noPhone')}>
                <MessageCircle size={16} aria-hidden="true" />
                {t('udhaar.whatsapp')}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label={t('udhaar.opening')} value={data.opening} />
        <Kpi label={t('udhaar.given')} value={data.udhaarGiven} tone="danger" />
        <Kpi label={t('udhaar.paid')} value={data.paid} tone="success" />
        <Kpi
          label={t('udhaar.closing')}
          value={data.closing}
          tone={data.closing > 0 ? 'danger' : undefined}
        />
      </div>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('sales.date')}</th>
              <th>{t('khata.entry')}</th>
              <th>{t('sales.invoice')}</th>
              <th className="num">{t('udhaar.given')}</th>
              <th className="num">{t('udhaar.paid')}</th>
              <th className="num">{t('khata.running')}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="text-muted">
              <td className="ltr text-sm">—</td>
              <td colSpan={4}>{t('udhaar.opening')}</td>
              <td className="num">
                <Money value={data.opening} symbol={null} className="font-semibold" />
              </td>
            </tr>
            {data.lines.map((l) => (
              <tr key={l.entry.id}>
                <td className="ltr text-sm">{formatDateTime(l.entry.createdAt)}</td>
                <td>
                  <Badge tone={l.entry.amount > 0 ? 'danger' : 'success'}>
                    {typeLabel(l.entry.type)}
                  </Badge>
                  {l.entry.method ? (
                    <span className="ms-2 text-xs text-muted">
                      {t(dynKey('method', l.entry.method))}
                    </span>
                  ) : null}
                  {l.entry.note ? (
                    <span className="ms-2 text-xs text-muted">{l.entry.note}</span>
                  ) : null}
                </td>
                <td className="ltr font-mono text-sm">
                  {l.entry.saleId && l.invoiceNo ? (
                    <button
                      type="button"
                      className="font-semibold text-primary-ink underline-offset-2 hover:underline"
                      onClick={() => setReceipt(l.entry.saleId)}
                    >
                      {l.invoiceNo}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="num">
                  {l.entry.amount > 0 ? (
                    <Money
                      value={l.entry.amount}
                      symbol={null}
                      className="text-[var(--danger-ink)]"
                    />
                  ) : null}
                </td>
                <td className="num">
                  {l.entry.amount < 0 ? (
                    <Money
                      value={Math.abs(l.entry.amount)}
                      symbol={null}
                      className="text-[var(--success-ink)]"
                    />
                  ) : null}
                </td>
                <td className="num">
                  <Money value={l.runningBalance} symbol={null} className="font-semibold" />
                </td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="ltr text-sm">—</td>
              <td colSpan={2}>{t('udhaar.closing')}</td>
              <td className="num">
                <Money
                  value={data.udhaarGiven}
                  symbol={null}
                  className="text-[var(--danger-ink)]"
                />
              </td>
              <td className="num">
                <Money value={data.paid} symbol={null} className="text-[var(--success-ink)]" />
              </td>
              <td className="num">
                <Money value={data.closing} symbol={null} />
              </td>
            </tr>
          </tbody>
        </table>
        {data.lines.length === 0 ? <Empty title={t('udhaar.noEntriesMonth')} /> : null}
      </div>

      <ReceiptDialog invoiceId={receipt} onClose={() => setReceipt(null)} />
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'danger' | 'success';
}): ReactNode {
  return (
    <div className="card card-pad">
      <div className="panel-title">{label}</div>
      <Money
        value={value}
        className={`mt-1 block text-2xl font-bold xl:text-3xl ${tone === 'danger' ? 'text-[var(--danger-ink)]' : tone === 'success' ? 'text-[var(--success-ink)]' : ''}`}
      />
    </div>
  );
}
