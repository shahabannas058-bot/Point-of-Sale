import { isServiceError } from '@pos/shared';
import { dynKey, translate, type TFn } from './index';
import { usePrefs } from '../store/prefs';

/** ServiceError -> localized sentence. Unknown errors map to err.generic (details are never shown raw). */
export function errorMessage(e: unknown, t: TFn): string {
  if (isServiceError(e)) {
    const key = dynKey('err', e.code);
    const d = e.details;
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'string' || typeof v === 'number') params[k] = v;
    }
    if (typeof d.retryAfterMs === 'number') params.seconds = Math.ceil(d.retryAfterMs / 1000);
    const text = t(key, params);
    // VALIDATION / DB_CONSTRAINT carry a developer message that is useful on screen.
    if ((e.code === 'VALIDATION' || e.code === 'DB_CONSTRAINT') && e.message) {
      return `${text} (${e.message})`;
    }
    return text;
  }
  return t('err.generic');
}

/** For non-React callers (stores, effects). */
export function errorMessageNow(e: unknown): string {
  const lang = usePrefs.getState().lang;
  return errorMessage(e, (k, p) => translate(lang, k, p));
}
