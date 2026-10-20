import { useState, type ReactNode } from 'react';
import { ArrowDownUp, Lock, Printer, ReceiptText, Undo2, Wallet } from 'lucide-react';
import type { CashEntryType, CashEntryView, DrawerSnapshot } from '@pos/shared';
import { CashEntryDialog } from '../components/cash/CashEntryDialog';
import { CloseDayDialog, DifferenceBadge } from '../components/cash/CloseDayDialog';
import { ReverseEntryDialog } from '../components/cash/ReverseEntryDialog';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { drawerRows } from '../lib/cash';
import { formatDateTime, formatTime } from '../lib/dates';
import { printPage } from '../lib/print';
import { useServiceQuery } from '../service/use-query';
import { useCan } from '../store/session';

function Breakdown({ d }: { d: DrawerSnapshot }): ReactNode {
  const t = useT();
  return (
    <section className="card">
      <h2 className="border-b border-line px-4 py-3 text-base">{t('cash.howItAddsUp')}</h2>
      <table className="tbl">
        <tbody>
          {drawerRows(d).map((r) => (
            <tr key={r.key}>
              <td className="font-medium">{t(dynKey('cash.row', r.key))}</td>
              <td className="num">
                <Money
                  value={r.value}
                  symbol={null}
                  className={`font-semibold ${r.value < 0 ? 'text-[var(--danger-ink)]' : ''}`}
                />
              </td>
            </tr>
          ))}
          <tr>
            <td className="font-bold">{t('cash.expected')}</td>
            <td className="num">
              <Money value={d.expected} className="text-lg font-bold" />
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function Entries({
  entries,
  canReverse,
  onReverse,
}: {
  entries: CashEntryView[];
  canReverse: boolean;
  onReverse: (e: CashEntryView) => void;
}): ReactNode {
  const t = useT();
  return (
    <section className="card">
      <h2 className="border-b border-line px-4 py-3 text-base">{t('cash.entries')}</h2>
      {entries.length === 0 ? (
        <Empty title={t('cash.noEntries')} />
      ) : (
        <div className="tbl-wrap border-0">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('cash.time')}</th>
                <th>{t('cash.type')}</th>
                <th>{t('cash.by')}</th>
                <th className="num">{t('pay.amount')}</th>
                {canReverse ? <th className="no-print">{t('common.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className={e.reversed ? 'opacity-60' : ''}>
                  <td className="ltr text-sm">{formatTime(e.createdAt)}</td>
                  <td>
                    <div className="font-semibold">
                      {e.category
                        ? t(dynKey('cash.cat', e.category))
                        : t(dynKey('cash.type', e.type))}{' '}
                      {e.reversed ? <Badge tone="muted">{t('cash.reversed')}</Badge> : null}
                      {e.reversesId ? <Badge tone="warning">{t('cash.reversal')}</Badge> : null}
                    </div>
                    {e.note ? <div className="text-xs text-muted">{e.note}</div> : null}
                  </td>
                  <td className="text-sm">{e.createdByName}</td>
                  <td className="num">
                    <Money
                      value={e.type === 'cash_in' ? e.amount : 0 - e.amount}
                      symbol={null}
                      className="font-semibold"
                    />
                  </td>
                  {canReverse ? (
                    <td className="no-print">
                      {!e.reversed && e.reversesId === null ? (
                        <Button size="sm" variant="ghost" onClick={() => onReverse(e)}>
                          <Undo2 size={14} aria-hidden="true" />
                          {t('cash.reverse')}
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function History(): ReactNode {
  const t = useT();
  const q = useServiceQuery((s) => s.cash.listCloses({ limit: 30 }), []);
  return (
    <section className="card">
      <h2 className="border-b border-line px-4 py-3 text-base">{t('cash.history')}</h2>
      {q.error ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <SkeletonRows rows={3} />
      ) : q.data.length === 0 ? (
        <Empty title={t('cash.noHistory')} />
      ) : (
        <div className="tbl-wrap border-0">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('cash.closedAt')}</th>
                <th className="num">{t('cash.expected')}</th>
                <th className="num">{t('cash.counted')}</th>
                <th>{t('cash.difference')}</th>
                <th className="num">{t('cash.carriedShort')}</th>
                <th>{t('cash.by')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id}>
                  <td className="ltr text-sm">
                    {formatDateTime(c.closedAt)}
                    {c.note ? <div className="text-xs text-muted">{c.note}</div> : null}
                  </td>
                  <td className="num">
                    <Money value={c.expected} symbol={null} />
                  </td>
                  <td className="num">
                    <Money value={c.counted} symbol={null} className="font-semibold" />
                  </td>
                  <td>
                    <DifferenceBadge value={c.difference} />
                  </td>
                  <td className="num">
                    <Money value={c.carriedForward} symbol={null} />
                  </td>
                  <td className="text-sm">{c.closedByName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The galla: what should be in the drawer now, expenses and cash in / out, and closing the day. */
export function CashDrawer(): ReactNode {
  const t = useT();
  const can = useCan();
  const q = useServiceQuery((s) => s.cash.drawer(), []);
  const [entryType, setEntryType] = useState<CashEntryType | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [reversing, setReversing] = useState<CashEntryView | null>(null);
  const d = q.data;

  return (
    <div>
      <PageHeader
        title={t('nav.cash')}
        subtitle={t('cash.subtitle')}
        actions={
          <>
            <Button className="no-print" onClick={printPage}>
              <Printer size={16} aria-hidden="true" />
              {t('common.print')}
            </Button>
            <Button className="no-print" onClick={() => setEntryType('cash_in')} disabled={!d}>
              <ArrowDownUp size={16} aria-hidden="true" />
              {t('cash.cashInOut')}
            </Button>
            <Button className="no-print" onClick={() => setEntryType('expense')} disabled={!d}>
              <ReceiptText size={16} aria-hidden="true" />
              {t('cash.addExpense')}
            </Button>
            <Button
              className="no-print"
              variant="primary"
              onClick={() => setCloseOpen(true)}
              disabled={!d}
            >
              <Lock size={16} aria-hidden="true" />
              {t('cash.closeDay')}
            </Button>
          </>
        }
      />

      {q.error ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : !d ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="card card-pad">
              <div className="panel-title flex items-center gap-2">
                <Wallet size={14} aria-hidden="true" />
                {t('cash.expected')}
              </div>
              <Money value={d.expected} className="mt-1 block text-3xl font-bold" />
              <div className="mt-1 text-xs text-muted">
                {d.periodStart === 0
                  ? t('cash.sinceStart')
                  : t('cash.since', { time: formatDateTime(d.periodStart) })}
              </div>
              {d.expected < 0 ? (
                <div role="note" className="mt-2 text-xs font-medium text-[var(--warning-ink)]">
                  {t('cash.belowZeroHint')}
                </div>
              ) : null}
            </div>
            <div className="card card-pad">
              <div className="panel-title">{t('cash.row.expenses')}</div>
              <Money
                value={d.expenses}
                className={`mt-1 block text-3xl font-bold ${d.expenses > 0 ? 'text-[var(--danger-ink)]' : ''}`}
              />
            </div>
            <div className="card card-pad">
              <div className="panel-title">{t('cash.lastClose')}</div>
              {d.lastClose ? (
                <div className="mt-2 flex flex-col items-start gap-1">
                  <DifferenceBadge value={d.lastClose.difference} />
                  <span className="ltr text-xs text-muted">
                    {formatDateTime(d.lastClose.closedAt)} · {d.lastClose.closedByName}
                  </span>
                </div>
              ) : (
                <div className="mt-2 text-muted">{t('cash.noClose')}</div>
              )}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Breakdown d={d} />
            <Entries entries={d.entries} canReverse={can('return_void')} onReverse={setReversing} />
          </div>

          {can('view_reports') ? <History /> : null}
        </div>
      )}

      <CashEntryDialog
        open={entryType !== null}
        startType={entryType ?? 'expense'}
        onClose={() => setEntryType(null)}
      />
      <CloseDayDialog
        open={closeOpen}
        expected={d?.expected ?? 0}
        lastCarried={d?.lastClose?.carriedForward ?? 0}
        onClose={() => setCloseOpen(false)}
      />
      <ReverseEntryDialog entry={reversing} onClose={() => setReversing(null)} />
    </div>
  );
}
