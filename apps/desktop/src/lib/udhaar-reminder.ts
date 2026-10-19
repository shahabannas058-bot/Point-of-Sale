import type { TFn } from '../i18n';
import { formatDate } from './dates';
import { formatRs } from './money';
import { waLink } from './whatsapp';

/** The wa.me link that opens a chat with the customer and a ready-typed udhaar reminder; null without a phone. */
export function reminderLink(
  t: TFn,
  i: { name: string; phone: string | null; balance: number; shopName: string; now?: number },
): string | null {
  const text = t('udhaar.reminderText', {
    name: i.name,
    shop: i.shopName,
    balance: formatRs(i.balance, { symbol: null }),
    date: formatDate(i.now ?? Date.now()),
  });
  return waLink(i.phone, text);
}
