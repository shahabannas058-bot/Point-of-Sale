import { useEffect, useRef, useState, type ReactNode } from 'react';
import { History } from 'lucide-react';
import {
  describeError,
  log,
  type ItemHistoryEntry,
  type ItemHistoryPage,
  type ItemRef,
  type UnitLabel,
  type UnitScale,
} from '@pos/shared';
import { useT } from '../i18n';
import { formatDateTime } from '../lib/dates';
import {
  SUMMARY_ROWS,
  historyDateRange,
  historyKindKey,
  historyKindTone,
  itemRefKey,
  referenceLines,
  signedQtyText,
} from '../lib/item-history';
import { qtyText, qtyWithUnit } from '../lib/qty';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Field, Input } from './ui/Field';
import { Empty, ErrorBox, SkeletonRows } from './ui/misc';

export interface ItemHistoryDialogProps {
  /** The item whose stock story is shown; null keeps the dialog closed. */
  item: ItemRef | null;
  label: string;
  unitScale: UnitScale;
  unitLabel: UnitLabel;
  open: boolean;
  onClose: () => void;
}

type Cursor = ItemHistoryPage['nextBefore'];

/** Pages loaded with "Load older", kept apart from the first page so a refetch of page one resets them. */
interface OlderPages {
  entries: ItemHistoryEntry[];
  nextBefore: Cursor;
}

export function ItemHistoryTable({
  entries,
  unitScale,
  unitLabel,
}: {
  entries: ItemHistoryEntry[];
  unitScale: UnitScale;
  unitLabel: UnitLabel;
}): ReactNode {
  const t = useT();
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>{t('sales.date')}</th>
          <th>{t('hist.type')}</th>
          <th className="num">{t('hist.qty')}</th>
          <th className="num">{t('hist.balance')}</th>
          <th>{t('hist.reference')}</th>
          <th>{t('hist.by')}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const ref = referenceLines(e, t);
          return (
            <tr key={e.id}>
              <td className="ltr text-sm whitespace-nowrap">{formatDateTime(e.at)}</td>
              <td>
                <Badge tone={historyKindTone(e.kind)}>{t(historyKindKey(e.kind))}</Badge>
              </td>
              <td className="num font-semibold">
                {signedQtyText(e.quantity, unitScale, unitLabel)}
              </td>
              <td className="num">{qtyText(e.balanceAfter, unitScale, unitLabel)}</td>
              <td>
                <div className="text-sm">{ref.main}</div>
                {ref.sub ? <div className="ltr text-xs text-muted">{ref.sub}</div> : null}
              </td>
              <td className="text-sm">{e.by.displayName}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SummaryChips({
  summary,
  unitScale,
  unitLabel,
}: {
  summary: ItemHistoryPage['summary'];
  unitScale: UnitScale;
  unitLabel: UnitLabel;
}): ReactNode {
  const t = useT();
  const piece = t('unit.piece');
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {SUMMARY_ROWS.map(([key, labelKey]) => (
        <div key={key} className="card card-pad">
          <div className="text-xs text-muted">{t(labelKey)}</div>
          <div className="num mt-0.5 font-semibold">
            {qtyWithUnit(summary[key], unitScale, unitLabel, piece)}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One item's whole stock story (like Abuzar's Ctrl+H): every movement newest first with the running balance,
 * who did it and what it belonged to. The first page follows the date range and every data write; older pages
 * are appended with "Load older".
 */
export function ItemHistoryDialog({
  item,
  label,
  unitScale,
  unitLabel,
  open,
  onClose,
}: ItemHistoryDialogProps): ReactNode {
  const t = useT();
  const service = useService();
  const [fromYmd, setFromYmd] = useState('');
  const [toYmd, setToYmd] = useState('');
  const [older, setOlder] = useState<OlderPages | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(undefined);

  const key = item ? itemRefKey(item) : '';
  const range = historyDateRange(fromYmd, toYmd);
  const page = useServiceQuery(
    (s) => s.catalog.itemHistory(item as ItemRef, range),
    [key, range.from, range.to],
    open && item !== null,
  );

  // a fresh first page (new item, new range, or a write elsewhere) makes the older pages stale
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1; // a reply to an older 'load older' call must not land on this page
    setOlder(null);
    setMoreError(undefined);
  }, [page.data]);

  // the range belongs to one look at one item
  useEffect(() => {
    if (!open) {
      setFromYmd('');
      setToYmd('');
    }
  }, [open, key]);

  const entries = older ? [...(page.data?.entries ?? []), ...older.entries] : page.data?.entries;
  const nextBefore: Cursor = older ? older.nextBefore : (page.data?.nextBefore ?? null);

  const loadOlder = async (): Promise<void> => {
    if (!item || !nextBefore || moreBusy) return;
    setMoreBusy(true);
    setMoreError(undefined);
    const gen = generation.current;
    try {
      const next = await service.catalog.itemHistory(item, { ...range, before: nextBefore });
      if (gen !== generation.current) return;
      setOlder((o) => ({
        entries: [...(o?.entries ?? []), ...next.entries],
        nextBefore: next.nextBefore,
      }));
    } catch (e: unknown) {
      log.warn('itemHistory.loadOlder.failed', { error: describeError(e) });
      setMoreError(e);
    } finally {
      setMoreBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={900}
      title={
        <span className="inline-flex items-center gap-2">
          <History size={18} aria-hidden="true" />
          {t('hist.title')}
        </span>
      }
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="flex flex-col gap-4">
        <div className="text-base font-semibold">{label}</div>

        {page.data ? (
          <SummaryChips summary={page.data.summary} unitScale={unitScale} unitLabel={unitLabel} />
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('sales.from')}>
            <Input
              type="date"
              value={fromYmd}
              max={toYmd || undefined}
              onChange={(e) => setFromYmd(e.target.value)}
              className="ltr w-auto"
            />
          </Field>
          <Field label={t('sales.to')}>
            <Input
              type="date"
              value={toYmd}
              min={fromYmd || undefined}
              onChange={(e) => setToYmd(e.target.value)}
              className="ltr w-auto"
            />
          </Field>
          {fromYmd || toYmd ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFromYmd('');
                setToYmd('');
              }}
            >
              {t('hist.allTime')}
            </Button>
          ) : null}
        </div>

        {page.error ? (
          <ErrorBox error={page.error} onRetry={page.reload} />
        ) : (
          <div className="tbl-wrap">
            {page.loading && !entries ? (
              <SkeletonRows />
            ) : !entries || entries.length === 0 ? (
              <Empty
                icon={<History size={26} aria-hidden="true" />}
                title={t('hist.noEntries')}
                hint={t('hist.noEntriesHint')}
              />
            ) : (
              <ItemHistoryTable entries={entries} unitScale={unitScale} unitLabel={unitLabel} />
            )}
          </div>
        )}

        {moreError !== undefined ? (
          <ErrorBox error={moreError} onRetry={() => void loadOlder()} />
        ) : null}
        {nextBefore ? (
          <div className="flex justify-center">
            <Button variant="secondary" loading={moreBusy} onClick={() => void loadOlder()}>
              {t('hist.loadOlder')}
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
