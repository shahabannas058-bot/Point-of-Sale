import { useCallback } from 'react';
import { usePrefs, type Lang } from '../store/prefs';
import { en } from './en';
import { ur } from './ur';

export type TKey = keyof typeof en;
export type Params = Record<string, string | number>;
export type TFn = (key: TKey, params?: Params) => string;

export const dictionaries: Record<Lang, Record<TKey, string>> = { en, ur };

export const dirOf = (lang: Lang): 'ltr' | 'rtl' => (lang === 'ur' ? 'rtl' : 'ltr');

/** Looks up `key` in `lang`, falling back to English, then to the key itself. `{name}` placeholders are interpolated. */
export function translate(lang: Lang, key: TKey, params?: Params): string {
  const raw = dictionaries[lang][key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    return v === undefined ? m : String(v);
  });
}

/** Builds a key for dynamic families such as `pta.approved` or `err.STOCK_INSUFFICIENT`; falls back to `fallback`. */
export function dynKey(prefix: string, value: string, fallback?: TKey): TKey {
  const k = `${prefix}.${value}`;
  if (k in en) return k as TKey;
  return fallback ?? 'err.generic';
}

export function useT(): TFn {
  const lang = usePrefs((s) => s.lang);
  return useCallback((key, params) => translate(lang, key, params), [lang]);
}

export function useLang(): Lang {
  return usePrefs((s) => s.lang);
}
