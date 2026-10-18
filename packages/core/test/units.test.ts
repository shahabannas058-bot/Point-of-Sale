import { describe, expect, it } from 'vitest';
import { InvoiceSchema, type Invoice, type UnsealedInvoice } from '@pos/shared';
import {
  HASH_VERSION,
  canonicalize,
  computeInvoiceHash,
  grossOf,
  invoiceHashPayload,
  lineTotal,
  mulPaisa,
  paisa,
  saleTotals,
  sealInvoice,
  verifyChain,
} from '../src';
import { buildChain, makeInvoice } from './fixtures';

describe('weighted line totals', () => {
  it('prices 1.25 kg at Rs 285.50/kg as 35,688 paisa (half away from zero)', () => {
    expect(
      lineTotal({
        quantity: 1250,
        unitScale: 1000,
        unitPrice: paisa(28_550),
        discountAmount: paisa(0),
      }),
    ).toBe(35_688);
  });

  it('returns round away from zero too', () => {
    expect(
      lineTotal({
        quantity: -1250,
        unitScale: 1000,
        unitPrice: paisa(28_550),
        discountAmount: paisa(0),
      }),
    ).toBe(-35_688);
  });

  it('a missing unitScale means pieces: identical to the old formula', () => {
    const line = { quantity: 7, unitPrice: paisa(12_345), discountAmount: paisa(0) };
    expect(grossOf(line)).toBe(mulPaisa(line.unitPrice, line.quantity));
    expect(lineTotal({ ...line, unitScale: 1 })).toBe(lineTotal(line));
  });

  it('applies the discount to the rounded gross and keeps it within the gross', () => {
    const base = { quantity: 2500, unitScale: 1000 as const, unitPrice: paisa(41_000) };
    expect(lineTotal({ ...base, discountAmount: paisa(1_025) })).toBe(101_475);
    expect(() => lineTotal({ ...base, discountAmount: paisa(102_501) })).toThrow(
      /outside 0\.\.102500/,
    );
  });

  it('saleTotals mixes piece and weighted lines', () => {
    const t = saleTotals(
      [
        { quantity: 3, unitPrice: paisa(2_500), discountAmount: paisa(0) },
        { quantity: 1250, unitScale: 1000, unitPrice: paisa(28_550), discountAmount: paisa(0) },
      ],
      paisa(0),
    );
    expect(t.lineTotals).toEqual([7_500, 35_688]);
    expect(t.subtotal).toBe(43_188);
    expect(t.total).toBe(43_188);
  });

  it('throws MONEY_INVALID when the gross leaves the safe range', () => {
    expect(() =>
      lineTotal({
        quantity: 100_000_000,
        unitScale: 1000,
        unitPrice: paisa(Number.MAX_SAFE_INTEGER),
        discountAmount: paisa(0),
      }),
    ).toThrow(/safe integer/);
  });
});

describe('hash version 2', () => {
  const asV2 = (inv: UnsealedInvoice, scale: 1 | 1000 = 1): UnsealedInvoice =>
    ({
      ...inv,
      hashVersion: 2,
      lines: inv.lines.map((l) => ({ ...l, unitScale: scale })),
    }) as unknown as UnsealedInvoice;

  it('new invoices are stamped with version 2', () => {
    expect(HASH_VERSION).toBe(2);
  });

  it('version 1 hashes ignore unitScale (so every stored hash stays valid)', () => {
    const v1 = makeInvoice();
    const withScale = {
      ...v1,
      lines: v1.lines.map((l) => ({ ...l, unitScale: 1 as const })),
    } as UnsealedInvoice;
    expect(canonicalize(invoiceHashPayload(withScale))).toBe(canonicalize(invoiceHashPayload(v1)));
    expect(computeInvoiceHash('0'.repeat(64), withScale)).toBe(
      computeInvoiceHash('0'.repeat(64), v1),
    );
    expect(canonicalize(invoiceHashPayload(v1))).not.toContain('unitScale');
  });

  it('version 2 hashes include every line unitScale', () => {
    const v2 = asV2(makeInvoice());
    expect(canonicalize(invoiceHashPayload(v2))).toContain('"unitScale":1');
  });

  it('changing a line unitScale changes the hash, so the unit cannot be rewritten silently', () => {
    const prev = '0'.repeat(64);
    const a = computeInvoiceHash(prev, asV2(makeInvoice(), 1));
    const b = computeInvoiceHash(prev, asV2(makeInvoice(), 1000));
    expect(a).not.toBe(b);
  });

  it('v1 and v2 of the same data hash differently', () => {
    const prev = '0'.repeat(64);
    expect(computeInvoiceHash(prev, makeInvoice())).not.toBe(
      computeInvoiceHash(prev, asV2(makeInvoice())),
    );
  });

  it('a chain may switch from v1 to v2 and still verifies', () => {
    const [first] = buildChain(1) as [Invoice];
    const second = InvoiceSchema.parse(
      sealInvoice(
        first.hash,
        asV2(
          makeInvoice({
            seq: 2,
            invoiceNo: 'A-000002',
            createdAt: (first.createdAt + 1000) as UnsealedInvoice['createdAt'],
          }),
        ),
      ),
    );
    expect(second.hashVersion).toBe(2);
    const result = verifyChain([first, second]);
    expect(result).toMatchObject({ ok: true, count: 2, headSeq: 2 });
  });

  it('editing a v2 line after sealing is detected', () => {
    const [first] = buildChain(1) as [Invoice];
    const second = InvoiceSchema.parse(
      sealInvoice(first.hash, asV2(makeInvoice({ seq: 2, invoiceNo: 'A-000002' }))),
    );
    const tampered = {
      ...second,
      lines: second.lines.map((l, i) => (i === 0 ? { ...l, unitScale: 1000 as const } : l)),
    };
    expect(verifyChain([first, tampered])).toMatchObject({
      ok: false,
      reason: 'hash_mismatch',
      index: 1,
    });
  });
});
