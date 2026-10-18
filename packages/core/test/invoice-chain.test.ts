import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, InvoiceSchema, type Invoice, type UnsealedInvoice } from '@pos/shared';
import {
  canonicalize,
  computeInvoiceHash,
  formatInvoiceNo,
  sealInvoice,
  sha256Hex,
  verifyChain,
  type CanonicalValue,
} from '@pos/core';
import { buildChain, expectDomainError, makeIdGenerator, makeInvoice } from './fixtures';

const clone = <T>(value: T): T => structuredClone(value);

/** Re-seals invoices[from..] in place so the tail is internally consistent again (attacker with full DB access). */
function rehashTail(chain: Invoice[], from: number): Invoice[] {
  const out = clone(chain);
  for (let i = from; i < out.length; i++) {
    const prev = i === 0 ? GENESIS_HASH : out[i - 1]!.hash;
    const { prevHash: _p, hash: _h, ...unsealed } = out[i]!;
    out[i] = sealInvoice(prev, unsealed);
  }
  return out;
}

describe('canonicalize', () => {
  it('sorts keys, drops whitespace and keeps unicode', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'é'] })).toBe('{"a":[true,null,"é"],"b":1}');
  });

  it('is independent of key insertion order, at every depth', () => {
    const one = canonicalize({ x: { b: 1, a: 2 }, y: [{ d: 1, c: 2 }] });
    const two = canonicalize({ y: [{ c: 2, d: 1 }], x: { a: 2, b: 1 } });
    expect(one).toBe(two);
  });

  it('escapes strings like JSON', () => {
    expect(canonicalize('a"b\\c\n')).toBe(JSON.stringify('a"b\\c\n'));
  });

  it('keeps array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it.each<[string, unknown]>([
    ['a float', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['a function', () => 1],
    ['a bigint', 10n],
    ['an unsafe integer', 2 ** 53],
  ])('rejects %s', (_label, value) => {
    expectDomainError(() => canonicalize(value as CanonicalValue), 'CANONICAL_INVALID');
  });

  it('rejects a bad value nested inside an object', () => {
    expectDomainError(() => canonicalize({ a: { b: 0.5 } }), 'CANONICAL_INVALID');
  });
});

describe('invoice hash', () => {
  it('does not depend on the order of lines or payments', () => {
    const inv = makeInvoice();
    const shuffled: UnsealedInvoice = {
      ...inv,
      lines: [...inv.lines].reverse(),
      payments: [...inv.payments].reverse(),
    };
    expect(computeInvoiceHash(GENESIS_HASH, shuffled)).toBe(computeInvoiceHash(GENESIS_HASH, inv));
  });

  it('depends on prevHash', () => {
    const inv = makeInvoice();
    expect(computeInvoiceHash(GENESIS_HASH, inv)).not.toBe(computeInvoiceHash('1'.repeat(64), inv));
  });

  it('sealInvoice stores prevHash and the computed hash', () => {
    const inv = makeInvoice();
    const sealed = sealInvoice(GENESIS_HASH, inv);
    expect(sealed.prevHash).toBe(GENESIS_HASH);
    expect(sealed.hash).toBe(computeInvoiceHash(GENESIS_HASH, inv));
    expect(sealed.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the golden value for a frozen invoice', () => {
    // Fixed literal ids and numbers: any change to the hashed fields, their names, the sort rule,
    // the domain prefix or the canonical form changes this value and must be a conscious v2 bump.
    const frozen: UnsealedInvoice = {
      id: '01993a00-0000-7000-8000-000000000001',
      deviceId: '01993a00-0000-7000-8000-000000000002',
      seq: 1,
      invoiceNo: 'A-000001',
      kind: 'sale',
      originalSaleId: null,
      branchId: '01993a00-0000-7000-8000-000000000003',
      customerId: '01993a00-0000-7000-8000-000000000004',
      cashierId: '01993a00-0000-7000-8000-000000000005',
      subtotal: 279955,
      discountTotal: 0,
      total: 279955,
      note: 'golden',
      createdAt: 1_760_000_000_000,
      hashVersion: 1,
      lines: [
        {
          id: '01993a00-0000-7000-8000-000000000011',
          saleId: '01993a00-0000-7000-8000-000000000001',
          lineNo: 1,
          productId: '01993a00-0000-7000-8000-000000000006',
          phoneUnitId: null,
          variantId: '01993a00-0000-7000-8000-000000000007',
          description: 'Fast Charger 25W',
          quantity: 2,
          unitPrice: 50000,
          costPrice: 30000,
          discountAmount: 0,
          lineTotal: 100000,
          createdAt: 1_760_000_000_000,
        },
        {
          id: '01993a00-0000-7000-8000-000000000012',
          saleId: '01993a00-0000-7000-8000-000000000001',
          lineNo: 2,
          productId: '01993a00-0000-7000-8000-000000000006',
          phoneUnitId: '01993a00-0000-7000-8000-000000000008',
          variantId: null,
          description: 'Galaxy A55 8/256 é',
          quantity: 1,
          unitPrice: 199950,
          costPrice: 150000,
          discountAmount: 19995,
          lineTotal: 179955,
          createdAt: 1_760_000_000_000,
        },
      ],
      payments: [
        {
          id: '01993a00-0000-7000-8000-000000000021',
          saleId: '01993a00-0000-7000-8000-000000000001',
          method: 'cash',
          amount: 179955,
          reference: null,
          createdAt: 1_760_000_000_000,
        },
        {
          id: '01993a00-0000-7000-8000-000000000022',
          saleId: '01993a00-0000-7000-8000-000000000001',
          method: 'khata',
          amount: 100000,
          reference: 'ref-1',
          createdAt: 1_760_000_000_000,
        },
      ],
    } as unknown as UnsealedInvoice;
    const sealed = sealInvoice(GENESIS_HASH, frozen);
    expect(InvoiceSchema.safeParse(sealed).success).toBe(true);
    // Recorded from the current implementation (first green run); it is a regression anchor, not an external spec.
    expect(sealed.hash).toBe('52a96840d1a6aed31f9b68a1ca105f146426c2318e2fad45a0c75cfe6908b959');
  });
});

describe('verifyChain: valid chains', () => {
  it('accepts a 5-invoice chain', () => {
    const chain = buildChain(5);
    expect(verifyChain(chain)).toEqual({
      ok: true,
      count: 5,
      headSeq: 5,
      headHash: chain[4]!.hash,
    });
  });

  it('accepts an empty chain with the genesis hash as head', () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0, headSeq: 0, headHash: GENESIS_HASH });
  });

  it('accepts the right expectedHeadHash', () => {
    const chain = buildChain(3);
    expect(verifyChain(chain, { expectedHeadHash: chain[2]!.hash }).ok).toBe(true);
  });

  it('verifies a slice from #3 with startSeq and startPrevHash', () => {
    const chain = buildChain(5);
    const result = verifyChain(chain.slice(2), { startSeq: 3, startPrevHash: chain[1]!.hash });
    expect(result).toEqual({ ok: true, count: 3, headSeq: 5, headHash: chain[4]!.hash });
  });

  it('rejects the same slice without the start options', () => {
    const chain = buildChain(5);
    const result = verifyChain(chain.slice(2));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('seq_gap');
  });
});

describe('verifyChain: edits', () => {
  const edits: [string, (inv: Invoice) => void][] = [
    [
      'total (kept consistent with discount and payment)',
      (inv) => {
        inv.discountTotal = 1000 as typeof inv.discountTotal;
        inv.total = 278955 as typeof inv.total;
        inv.payments[0]!.amount = 178955 as (typeof inv.payments)[number]['amount'];
        // the edit is internally consistent, so the schema cannot catch it; only the hash does
        expect(InvoiceSchema.safeParse(inv).success).toBe(true);
      },
    ],
    [
      'a line unitPrice',
      (inv) => {
        inv.lines[0]!.unitPrice = 49999 as (typeof inv.lines)[number]['unitPrice'];
      },
    ],
    [
      'a payment method (cash to khata)',
      (inv) => {
        inv.payments[0]!.method = 'khata';
      },
    ],
    [
      'note',
      (inv) => {
        inv.note = 'edited later';
      },
    ],
    [
      'createdAt',
      (inv) => {
        inv.createdAt = (inv.createdAt - 86_400_000) as typeof inv.createdAt;
      },
    ],
  ];

  it.each(edits)('detects an edit to %s at the edited index', (_label, edit) => {
    const chain = clone(buildChain(5));
    edit(chain[2]!);
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('hash_mismatch');
      expect(result.index).toBe(2);
      expect(result.invoiceId).toBe(chain[2]!.id);
      expect(result.actual).toBe(chain[2]!.hash);
      expect(result.expected).not.toBe(result.actual);
    }
  });

  it('detects an edit plus re-hash of only that invoice at the NEXT index', () => {
    const chain = clone(buildChain(5));
    chain[2]!.note = 'edited and re-hashed';
    const { prevHash, hash: _old, ...unsealed } = chain[2]!;
    chain[2] = sealInvoice(prevHash, unsealed);
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('prev_hash_mismatch');
      expect(result.index).toBe(3);
    }
  });

  it('detects an invoice whose own prevHash was rewritten', () => {
    const chain = clone(buildChain(3));
    chain[1]!.prevHash = '2'.repeat(64);
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('prev_hash_mismatch');
      expect(result.index).toBe(1);
    }
  });
});

describe('verifyChain: deletion, reordering, duplicates', () => {
  it('detects a deleted middle invoice as a seq gap at that index', () => {
    const chain = buildChain(5);
    const result = verifyChain(chain.filter((_, i) => i !== 2));
    expect(result).toMatchObject({
      ok: false,
      reason: 'seq_gap',
      index: 2,
      expected: '3',
      actual: '4',
    });
  });

  it('detects a deleted first invoice at index 0', () => {
    const chain = buildChain(5);
    const result = verifyChain(chain.slice(1));
    expect(result).toMatchObject({ ok: false, reason: 'seq_gap', index: 0 });
  });

  it('cannot see a deleted LAST invoice without expectedHeadHash', () => {
    const chain = buildChain(5);
    const truncated = chain.slice(0, 4);
    expect(verifyChain(truncated).ok).toBe(true);
    const result = verifyChain(truncated, { expectedHeadHash: chain[4]!.hash });
    expect(result).toMatchObject({
      ok: false,
      reason: 'head_mismatch',
      index: 3,
      expected: chain[4]!.hash,
      actual: chain[3]!.hash,
    });
  });

  it('head_mismatch on an empty chain reports a null invoice id', () => {
    const result = verifyChain([], { expectedHeadHash: '3'.repeat(64) });
    expect(result).toMatchObject({
      ok: false,
      reason: 'head_mismatch',
      index: -1,
      invoiceId: null,
    });
  });

  it('detects swapped invoices #2 and #3', () => {
    const chain = buildChain(5);
    const swapped = [chain[0]!, chain[2]!, chain[1]!, chain[3]!, chain[4]!];
    expect(verifyChain(swapped)).toMatchObject({ ok: false, reason: 'seq_gap', index: 1 });
  });

  it('detects a duplicated invoice appended at the end', () => {
    const chain = buildChain(5);
    expect(verifyChain([...chain, chain[4]!])).toMatchObject({
      ok: false,
      reason: 'seq_gap',
      index: 5,
    });
  });
});

describe('verifyChain: documented limitation', () => {
  it('a fully re-hashed tail verifies ok alone, and only expectedHeadHash exposes it', () => {
    const chain = buildChain(5);
    const forged = clone(chain);
    forged[2]!.note = 'attacker rewrote history';
    const rehashed = rehashTail(forged, 2);
    // Limitation: a consistent forgery is invisible to a purely local check...
    expect(verifyChain(rehashed).ok).toBe(true);
    // ...unless the head hash was recorded elsewhere (e.g. the server after sync).
    expect(verifyChain(rehashed, { expectedHeadHash: chain[4]!.hash })).toMatchObject({
      ok: false,
      reason: 'head_mismatch',
    });
  });
});

describe('verifyChain: other failures', () => {
  it('rejects invoices from two devices', () => {
    const gen = makeIdGenerator(21);
    const other = gen() as unknown as Invoice['deviceId'];
    const chain = buildChain(3);
    const mixed = [chain[0]!, { ...chain[1]!, deviceId: other }, chain[2]!];
    expect(verifyChain(mixed)).toMatchObject({ ok: false, reason: 'mixed_devices', index: 1 });
  });

  it('rejects an unsupported hash version', () => {
    const chain = buildChain(2);
    const v3 = [chain[0]!, { ...chain[1]!, hashVersion: 3 } as unknown as Invoice];
    expect(verifyChain(v3)).toMatchObject({
      ok: false,
      reason: 'unsupported_hash_version',
      index: 1,
      expected: '2', // the version stamped on new invoices
      actual: '3',
    });
  });
});

describe('formatInvoiceNo', () => {
  it('pads the sequence to six digits', () => {
    expect(formatInvoiceNo('A', 12)).toBe('A-000012');
    expect(formatInvoiceNo('SHOP', 1)).toBe('SHOP-000001');
    expect(formatInvoiceNo('A', 1_234_567)).toBe('A-1234567');
  });

  it('rejects bad prefixes and sequences', () => {
    expectDomainError(() => formatInvoiceNo('a', 1), 'INVOICE_NO_INVALID');
    expectDomainError(() => formatInvoiceNo('TOOLONG', 1), 'INVOICE_NO_INVALID');
    expectDomainError(() => formatInvoiceNo('', 1), 'INVOICE_NO_INVALID');
    expectDomainError(() => formatInvoiceNo('A', 0), 'INVOICE_NO_INVALID');
    expectDomainError(() => formatInvoiceNo('A', -3), 'INVOICE_NO_INVALID');
    expectDomainError(() => formatInvoiceNo('A', 1.5), 'INVOICE_NO_INVALID');
  });
});

describe('sha256Hex', () => {
  it('matches known SHA-256 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
