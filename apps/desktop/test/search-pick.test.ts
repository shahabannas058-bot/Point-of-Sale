import { describe, expect, it } from 'vitest';
import { pickableHit } from '../src/lib/search-pick';

const hits = ['namak', 'chini'] as const;

describe('pickableHit: Enter in the billing search', () => {
  it('picks the highlighted hit when the hits belong to the text in the box', () => {
    expect(pickableHit({ hits, active: 0, open: true, hitsFor: 's', term: 's' })).toBe('namak');
  });

  it('ignores a highlighted hit left over from an older text (a fast scan + Enter)', () => {
    expect(
      pickableHit({ hits, active: 0, open: true, hitsFor: 's', term: 'SHAN-BIR-50' }),
    ).toBeUndefined();
  });

  it('ignores the list when it is closed or nothing is highlighted', () => {
    expect(pickableHit({ hits, active: 0, open: false, hitsFor: 's', term: 's' })).toBeUndefined();
    expect(pickableHit({ hits, active: -1, open: true, hitsFor: 's', term: 's' })).toBeUndefined();
    expect(pickableHit({ hits, active: 5, open: true, hitsFor: 's', term: 's' })).toBeUndefined();
  });
});
