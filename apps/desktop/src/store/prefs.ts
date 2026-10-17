import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 'ur' = Roman Urdu (Urdu in Latin letters). The id stays 'ur' so saved preferences keep working. */
export type Lang = 'en' | 'ur';
export type ThemePref = 'light' | 'dark' | 'system';
export type ReceiptWidth = '58' | '80';
export type ReceiptLang = 'en' | 'ur' | 'both';

export interface PrefsState {
  lang: Lang;
  theme: ThemePref;
  receiptWidth: ReceiptWidth;
  receiptLang: ReceiptLang;
  /** Liquid glass surfaces; off = solid surfaces for slow PCs. */
  glass: boolean;
  setLang: (l: Lang) => void;
  setTheme: (t: ThemePref) => void;
  setReceiptWidth: (w: ReceiptWidth) => void;
  setReceiptLang: (l: ReceiptLang) => void;
  setGlass: (on: boolean) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      lang: 'en',
      theme: 'system',
      receiptWidth: '80',
      receiptLang: 'both',
      glass: true,
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      setReceiptWidth: (receiptWidth) => set({ receiptWidth }),
      setReceiptLang: (receiptLang) => set({ receiptLang }),
      setGlass: (glass) => set({ glass }),
    }),
    { name: 'pos-prefs' },
  ),
);

/** Mirrors prefs onto <html>: lang, data-theme and data-glass. 'ur' is Roman Urdu, so the page stays LTR. */
export function applyPrefsToDocument(): void {
  const apply = (s: PrefsState): void => {
    const root = document.documentElement;
    root.lang = s.lang === 'ur' ? 'ur-Latn' : 'en';
    root.dir = 'ltr';
    if (s.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', s.theme);
    if (s.glass) root.removeAttribute('data-glass');
    else root.setAttribute('data-glass', 'off');
  };
  apply(usePrefs.getState());
  usePrefs.subscribe(apply);
}
