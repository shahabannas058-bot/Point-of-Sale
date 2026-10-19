import type {
  ItemHistoryEntry,
  ItemHistoryKind,
  ItemHistoryPage,
  ItemHistoryQuery,
  ItemRef,
  UnitLabel,
  UnitScale,
} from '@pos/shared';
import type { Tone } from '../components/ui/Badge';
import type { TFn, TKey } from '../i18n';
import { localDayRange } from './dates';
import { qtyText } from './qty';

/* Pure helpers for the item history dialog (Ctrl+H): what each row says, in which colour. */

const KIND_KEY: Record<ItemHistoryKind, TKey> = {
  sale: 'hist.kind.sale',
  return: 'hist.kind.return',
  purchase: 'hist.kind.purchase',
  adjustment: 'hist.kind.adjustment',
  repair: 'hist.kind.repair',
  transfer: 'hist.kind.transfer',
};

/** The i18n key of a movement kind's label. */
export const historyKindKey = (kind: ItemHistoryKind): TKey => KIND_KEY[kind];

/** Stock in = green, stock out = red, a correction = amber; status colours only, as everywhere in the app. */
export function historyKindTone(kind: ItemHistoryKind): Tone {
  switch (kind) {
    case 'purchase':
    case 'return':
      return 'success';
    case 'sale':
    case 'repair':
      return 'danger';
    case 'adjustment':
      return 'warning';
    case 'transfer':
      return 'muted';
  }
}

/** "+3", "-2", "+1.25 kg", "-0.5 kg", "0": the movement in the item's own unit with its sign always written. */
export function signedQtyText(quantity: number, scale: UnitScale, unit: UnitLabel): string {
  const text = qtyText(quantity, scale, unit);
  return quantity > 0 ? `+${text}` : text;
}

export interface ReferenceLines {
  /** What the movement belonged to: invoice + customer, supplier + bill no, ticket no, or the reason. */
  main: string;
  /** Batch / expiry and any note that is not already the main line; null when there is nothing more to say. */
  sub: string | null;
}

/** The main line: "Invoice K-000012 · Haji Rafiq", "Supplier Mandi · ref 123", "Ticket R-0004", or the reason. */
export function referenceText(entry: Pick<ItemHistoryEntry, 'ref' | 'reason'>, t: TFn): string {
  const { ref } = entry;
  switch (ref.kind) {
    case 'sale':
    case 'return':
      return [`${t('sales.invoice')} ${ref.invoiceNo}`, ref.customerName]
        .filter(Boolean)
        .join(' · ');
    case 'purchase':
      return [
        `${t('recv.supplier')} ${ref.supplierName}`,
        ref.referenceNo ? `${t('hist.ref')} ${ref.referenceNo}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'repair':
      return `${t('repair.ticket')} ${ref.ticketNo}`;
    case 'adjustment':
      return entry.reason ?? '—';
    case 'transfer':
      return t('hist.kind.transfer');
  }
}

/** "Batch B12 · exp 2026-11-30" (the expiry stays as stored, the way the Expiry screen shows it). */
export function batchText(batch: ItemHistoryEntry['batch'], t: TFn): string | null {
  if (!batch) return null;
  const name = batch.batchNo ? `${t('expiry.batch')} ${batch.batchNo}` : t('expiry.batch');
  return `${name} · ${t('hist.exp')} ${batch.expiryDate}`;
}

/** Both lines of the Reference cell. An adjustment's reason is its main line, so it is not repeated below. */
export function referenceLines(
  entry: Pick<ItemHistoryEntry, 'ref' | 'reason' | 'batch'>,
  t: TFn,
): ReferenceLines {
  const extras = [batchText(entry.batch, t), entry.ref.kind === 'adjustment' ? null : entry.reason];
  const sub = extras.filter((s): s is string => s !== null && s !== '').join(' · ');
  return { main: referenceText(entry, t), sub: sub === '' ? null : sub };
}

export type SummaryKey = keyof ItemHistoryPage['summary'];

/** Header chips in display order with their labels. */
export const SUMMARY_ROWS: readonly [SummaryKey, TKey][] = [
  ['purchased', 'hist.purchased'],
  ['sold', 'hist.sold'],
  ['returned', 'hist.returned'],
  ['adjusted', 'hist.adjusted'],
  ['onHand', 'hist.onHand'],
];

/**
 * The query bounds for the two date boxes (YYYY-MM-DD or empty). Both ends are whole local days, the
 * `to` day included; an empty box means unbounded on that side. A `to` before `from` is left to the service
 * (it simply finds nothing).
 */
export function historyDateRange(
  fromYmd: string,
  toYmd: string,
): Pick<ItemHistoryQuery, 'from' | 'to'> {
  return {
    ...(fromYmd ? { from: localDayRange(fromYmd).fromMs } : {}),
    ...(toYmd ? { to: localDayRange(toYmd).toMs - 1 } : {}),
  };
}

/** A stable key for a dialog's item, for query dependencies. */
export const itemRefKey = (ref: ItemRef): string =>
  'variantId' in ref ? `v:${ref.variantId}` : `p:${ref.phoneUnitId}`;

/** Which item a cart line is: a variant or a phone unit; null for a line that has neither (should not happen). */
export function cartLineItemRef(line: {
  variantId?: string;
  phoneUnitId?: string;
}): ItemRef | null {
  if (line.variantId) return { variantId: line.variantId };
  if (line.phoneUnitId) return { phoneUnitId: line.phoneUnitId };
  return null;
}
