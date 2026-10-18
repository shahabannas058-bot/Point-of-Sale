import { useRef, type ReactNode } from 'react';
import { useT } from '../i18n';
import { usePrefs, type Lang } from '../store/prefs';
import { MorphPill } from './ui/MorphPill';

/** Language names are shown in their own words and never translated, so the active one is always unambiguous. */
const OPTIONS: { value: Lang; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'ur', label: 'Roman Urdu' },
];

/** Two-option switch: the highlighted option is the language the app is in right now. */
export function LanguageSwitch(): ReactNode {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const setLang = usePrefs((s) => s.setLang);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="seg" role="group" aria-label={t('shell.toggleLang')}>
      <MorphPill containerRef={ref} selector="[aria-pressed='true']" watch={lang} />
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={lang === o.value}
          onClick={() => setLang(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
