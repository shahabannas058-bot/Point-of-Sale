import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'en' | 'ur';
export type ThemePref = 'light' | 'dark' | 'system';
export type ReceiptWidth = '58' | '80';
export type ReceiptLang = 'en' | 'ur' | 'both';

export interface PrefsState {
  lang: Lang;
  theme: ThemePref;
  receiptWidth: ReceiptWidth;
  receiptLang: ReceiptLang;
  setLang: (l: Lang) => void;
  setTheme: (t: ThemePref) => void;
  setReceiptWidth: (w: ReceiptWidth) => void;
  setReceiptLang: (l: ReceiptLang) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      lang: 'en',
      theme: 'system',
      receiptWidth: '80',
      receiptLang: 'both',
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      setReceiptWidth: (receiptWidth) => set({ receiptWidth }),
      setReceiptLang: (receiptLang) => set({ receiptLang }),
    }),
    { name: 'pos-prefs' },
  ),
);

/** Mirrors prefs onto <html>: lang, dir and data-theme. Call once at startup. */
export function applyPrefsToDocument(): void {
  const apply = (s: PrefsState): void => {
    const root = document.documentElement;
    root.lang = s.lang;
    root.dir = s.lang === 'ur' ? 'rtl' : 'ltr';
    if (s.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', s.theme);
  };
  apply(usePrefs.getState());
  usePrefs.subscribe(apply);
}
