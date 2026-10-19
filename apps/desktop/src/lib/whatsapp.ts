/**
 * WhatsApp click-to-chat links for udhaar reminders. Customer phones are stored as typed and normalised to
 * digits (03001234567 or +923001234567); wa.me wants the international number without the plus.
 */

/** "03001234567" -> "923001234567"; already-international numbers pass through; null when not a usable number. */
export function waNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return `92${digits.slice(1)}`;
  return digits;
}

/** https://wa.me/<number>?text=<encoded>, or null when the phone is unusable. */
export function waLink(phone: string | null | undefined, text: string): string | null {
  const n = waNumber(phone);
  if (n === null) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}
