import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ur } from '../src/i18n/ur';
import { NICHE_KEYS, nicheKey } from '../src/i18n/niche';

describe('nicheKey: a kiryana shop never reads mobile-shop wording', () => {
  it('keeps the key for a shop with phones', () => {
    expect(nicheKey(true, 'billing.searchPlaceholder')).toBe('billing.searchPlaceholder');
  });

  it('swaps to the items twin for a shop without the imei module', () => {
    expect(nicheKey(false, 'billing.searchPlaceholder')).toBe('billing.searchPlaceholder.items');
    expect(nicheKey(false, 'common.cancel')).toBe('common.cancel');
  });

  it('no items twin mentions IMEI, phones or accessories, in either language', () => {
    for (const key of NICHE_KEYS) {
      const twin = nicheKey(false, key);
      expect(twin).not.toBe(key);
      for (const text of [en[twin], ur[twin]]) {
        expect(text, `${twin}: ${text}`).not.toMatch(/imei|phone|accessor|mobile/i);
      }
    }
  });
});
