import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ur } from '../src/i18n/ur';

/** Words of the removed mobile-shop features. The app is grocery only, so no screen text may use them. */
const MOBILE_SHOP = /imei|warranty|repair ticket|phone unit|\bpta\b/i;

/**
 * Keys that are allowed to talk about phones or repairs: a customer's or supplier's phone number, and the cash
 * book's "Shop repairs" expense category (fixing the shop, not phones).
 */
const ALLOWED = (key: string): boolean =>
  key === 'cash.cat.maintenance' ||
  (/phone/i.test(key) && /^(customers|suppliers|udhaar|khata|shop|settings)\./.test(key));

describe('i18n: no mobile-shop wording is left', () => {
  for (const [lang, dict] of [
    ['en', en],
    ['ur', ur],
  ] as const) {
    it(`${lang} has no mobile-shop keys or text`, () => {
      const hits = Object.entries(dict)
        .filter(([key]) => !ALLOWED(key))
        .filter(
          ([key, text]) =>
            MOBILE_SHOP.test(key) ||
            MOBILE_SHOP.test(text) ||
            /^(repair|warranty|pta|condition)\./.test(key),
        )
        .map(([key]) => key);
      expect(hits).toEqual([]);
    });
  }

  it('says "item", never "accessory"', () => {
    const hits = [...Object.entries(en), ...Object.entries(ur)]
      .filter(([key, text]) => /accessor/i.test(key) || /accessor/i.test(text))
      .map(([key]) => key);
    expect(hits).toEqual([]);
  });
});
