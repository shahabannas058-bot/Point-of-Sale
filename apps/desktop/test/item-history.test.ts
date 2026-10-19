import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ItemHistoryEntry, ItemHistoryKind, PosService } from '@pos/shared';
import { ItemHistoryDialog, ItemHistoryTable } from '../src/components/ItemHistoryDialog';
import { translate, type TFn } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ur } from '../src/i18n/ur';
import { localDayRange } from '../src/lib/dates';
import {
  SUMMARY_ROWS,
  batchText,
  cartLineItemRef,
  historyDateRange,
  historyKindKey,
  historyKindTone,
  itemRefKey,
  referenceLines,
  referenceText,
  signedQtyText,
} from '../src/lib/item-history';
import { RuntimeProvider } from '../src/service/context';

const t: TFn = (key, params) => translate('en', key, params);
const KINDS: ItemHistoryKind[] = ['sale', 'return', 'purchase', 'adjustment', 'repair', 'transfer'];

const entry = (over: Partial<ItemHistoryEntry> = {}): ItemHistoryEntry => ({
  id: 'm1',
  at: new Date(2026, 9, 18, 14, 5).getTime(),
  kind: 'sale',
  quantity: -2,
  balanceAfter: 10,
  unitCost: null,
  ref: { kind: 'sale', saleId: 's1', invoiceNo: 'K-000012', customerName: 'Haji Rafiq' },
  reason: null,
  batch: null,
  by: { id: 'u1', displayName: 'Usman' },
  ...over,
});

describe('historyKindKey / historyKindTone', () => {
  it('every kind has a label in both languages', () => {
    for (const k of KINDS) {
      const key = historyKindKey(k);
      expect(key in en, key).toBe(true);
      expect(key in ur, key).toBe(true);
    }
  });

  it('uses green for stock in, red for stock out, amber for corrections', () => {
    expect(historyKindTone('purchase')).toBe('success');
    expect(historyKindTone('return')).toBe('success');
    expect(historyKindTone('sale')).toBe('danger');
    expect(historyKindTone('repair')).toBe('danger');
    expect(historyKindTone('adjustment')).toBe('warning');
    expect(historyKindTone('transfer')).toBe('muted');
  });
});

describe('signedQtyText', () => {
  it('writes the sign for pieces', () => {
    expect(signedQtyText(3, 1, 'pcs')).toBe('+3');
    expect(signedQtyText(-1, 1, 'pcs')).toBe('-1');
    expect(signedQtyText(0, 1, 'pcs')).toBe('0');
  });

  it('formats weighed goods in their unit', () => {
    expect(signedQtyText(1250, 1000, 'kg')).toBe('+1.25 kg');
    expect(signedQtyText(-500, 1000, 'kg')).toBe('-0.5 kg');
    expect(signedQtyText(-2000, 1000, 'L')).toBe('-2 L');
  });
});

describe('referenceText', () => {
  it('sale and return: invoice and customer', () => {
    expect(referenceText(entry(), t)).toBe('Invoice K-000012 · Haji Rafiq');
    expect(
      referenceText(
        entry({
          ref: { kind: 'return', saleId: 's2', invoiceNo: 'K-000013', customerName: null },
        }),
        t,
      ),
    ).toBe('Invoice K-000013');
  });

  it('purchase: supplier and bill reference', () => {
    const ref = { kind: 'purchase', purchaseId: 'p1', supplierName: 'Mandi' } as const;
    expect(referenceText(entry({ ref: { ...ref, referenceNo: '123' } }), t)).toBe(
      'Supplier Mandi · ref 123',
    );
    expect(referenceText(entry({ ref: { ...ref, referenceNo: null } }), t)).toBe('Supplier Mandi');
  });

  it('repair: ticket number', () => {
    expect(
      referenceText(entry({ ref: { kind: 'repair', ticketId: 'r1', ticketNo: 'R-0004' } }), t),
    ).toBe('Ticket R-0004');
  });

  it('adjustment: the reason, or a dash', () => {
    expect(referenceText(entry({ ref: { kind: 'adjustment' }, reason: 'Opening stock' }), t)).toBe(
      'Opening stock',
    );
    expect(referenceText(entry({ ref: { kind: 'adjustment' }, reason: null }), t)).toBe('—');
  });

  it('transfer: the kind label', () => {
    expect(referenceText(entry({ ref: { kind: 'transfer', transferId: 'x1' } }), t)).toBe(
      'Transfer',
    );
  });
});

describe('batchText / referenceLines', () => {
  it('batch line shows number and expiry as stored', () => {
    expect(batchText({ id: 'b', batchNo: 'B12', expiryDate: '2026-11-30' }, t)).toBe(
      'Batch B12 · exp 2026-11-30',
    );
    expect(batchText({ id: 'b', batchNo: null, expiryDate: '2026-11-30' }, t)).toBe(
      'Batch · exp 2026-11-30',
    );
    expect(batchText(null, t)).toBeNull();
  });

  it('second line carries the batch and a note; adjustments do not repeat their reason', () => {
    expect(referenceLines(entry(), t)).toEqual({
      main: 'Invoice K-000012 · Haji Rafiq',
      sub: null,
    });
    expect(
      referenceLines(
        entry({ batch: { id: 'b', batchNo: 'B12', expiryDate: '2026-11-30' }, reason: 'FEFO' }),
        t,
      ).sub,
    ).toBe('Batch B12 · exp 2026-11-30 · FEFO');
    expect(referenceLines(entry({ ref: { kind: 'adjustment' }, reason: 'Broken' }), t)).toEqual({
      main: 'Broken',
      sub: null,
    });
  });
});

describe('historyDateRange', () => {
  it('empty boxes mean no bounds', () => {
    expect(historyDateRange('', '')).toEqual({});
  });

  it('from is the start of its day, to is the last millisecond of its day', () => {
    const r = historyDateRange('2026-10-01', '2026-10-18');
    expect(r.from).toBe(localDayRange('2026-10-01').fromMs);
    expect(r.to).toBe(localDayRange('2026-10-18').toMs - 1);
    expect(historyDateRange('2026-10-01', '')).toEqual({ from: r.from });
    expect(historyDateRange('', '2026-10-18')).toEqual({ to: r.to });
  });
});

describe('itemRefKey / cartLineItemRef / SUMMARY_ROWS', () => {
  it('keys tell variants from phone units', () => {
    expect(itemRefKey({ variantId: 'a' })).toBe('v:a');
    expect(itemRefKey({ phoneUnitId: 'a' })).toBe('p:a');
  });

  it('cart lines map to their item', () => {
    expect(cartLineItemRef({ variantId: 'v1' })).toEqual({ variantId: 'v1' });
    expect(cartLineItemRef({ phoneUnitId: 'p1' })).toEqual({ phoneUnitId: 'p1' });
    expect(cartLineItemRef({})).toBeNull();
  });

  it('summary chips are in Abuzar order and all labelled', () => {
    expect(SUMMARY_ROWS.map(([k]) => k)).toEqual([
      'purchased',
      'sold',
      'returned',
      'adjusted',
      'onHand',
    ]);
    for (const [, key] of SUMMARY_ROWS) expect(key in ur, key).toBe(true);
  });
});

describe('ItemHistoryTable rendering', () => {
  it('shows date, coloured kind, signed qty, balance, reference lines and user', () => {
    const html = renderToStaticMarkup(
      createElement(ItemHistoryTable, {
        unitScale: 1000,
        unitLabel: 'kg',
        entries: [
          entry({ quantity: -500, balanceAfter: 9500 }),
          entry({
            id: 'm0',
            kind: 'purchase',
            quantity: 10000,
            balanceAfter: 10000,
            ref: { kind: 'purchase', purchaseId: 'p1', supplierName: 'Mandi', referenceNo: '77' },
            batch: { id: 'b', batchNo: 'B12', expiryDate: '2026-11-30' },
            by: { id: 'u2', displayName: 'Ali' },
          }),
        ],
      }),
    );
    expect(html).toContain('18-10-2026 14:05');
    expect(html).toContain('badge-danger');
    expect(html).toContain('badge-success');
    expect(html).toContain('-0.5 kg');
    expect(html).toContain('+10 kg');
    expect(html).toContain('9.5 kg');
    expect(html).toContain('Invoice K-000012 · Haji Rafiq');
    expect(html).toContain('Supplier Mandi · ref 77');
    expect(html).toContain('Batch B12 · exp 2026-11-30');
    expect(html).toContain('Usman');
    expect(html).toContain('Ali');
  });
});

describe('ItemHistoryDialog rendering', () => {
  const fakeService = (): PosService =>
    ({
      catalog: {
        itemHistory: vi.fn(() =>
          Promise.resolve({
            entries: [],
            nextBefore: null,
            summary: { purchased: 0, sold: 0, returned: 0, adjusted: 0, onHand: 0 },
          }),
        ),
      },
    }) as unknown as PosService;

  const withRuntime = (service: PosService, child: ReactNode): ReactNode =>
    createElement(RuntimeProvider, {
      runtime: { service, loadDemo: () => Promise.resolve() },
      children: child,
    });

  it('open: header, item label, date range and the loading state before data arrives', () => {
    const html = renderToStaticMarkup(
      withRuntime(
        fakeService(),
        createElement(ItemHistoryDialog, {
          item: { variantId: 'v1' },
          label: 'Shan Masala 50 g',
          unitScale: 1,
          unitLabel: 'pcs',
          open: true,
          onClose: () => undefined,
        }),
      ),
    );
    expect(html).toContain('Item history');
    expect(html).toContain('Shan Masala 50 g');
    expect(html).toContain('type="date"');
    expect(html).toContain('skeleton');
    expect(html).not.toContain('Load older');
  });

  it('closed: mounts nothing inside the dialog', () => {
    const html = renderToStaticMarkup(
      withRuntime(
        fakeService(),
        createElement(ItemHistoryDialog, {
          item: null,
          label: '',
          unitScale: 1,
          unitLabel: 'pcs',
          open: false,
          onClose: () => undefined,
        }),
      ),
    );
    expect(html).not.toContain('Item history');
  });
});
