import { useEffect, useRef, type ReactNode } from 'react';
import { Delete } from 'lucide-react';
import { useT } from '../../i18n';

/** A PIN is exactly this many digits (the service enforces the same rule). */
export const PIN_LENGTH = 4;

export interface PinPadProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  maxLength?: number;
  minLength?: number;
  disabled?: boolean;
  /** listen to the physical keyboard (digits, Backspace, Enter) while mounted */
  keyboard?: boolean;
}

/** Large (56px) keys for fast, touch-friendly entry; also accepts the physical keyboard. */
export function PinPad({
  value,
  onChange,
  onSubmit,
  maxLength = PIN_LENGTH,
  minLength = PIN_LENGTH,
  disabled = false,
  keyboard = true,
}: PinPadProps): ReactNode {
  const t = useT();
  const live = useRef({ value, onChange, onSubmit, maxLength, minLength, disabled });
  live.current = { value, onChange, onSubmit, maxLength, minLength, disabled };

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent): void => {
      const s = live.current;
      if (s.disabled || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'))
        return;
      if (/^\d$/.test(e.key)) {
        if (s.value.length < s.maxLength) s.onChange(s.value + e.key);
        e.preventDefault();
      } else if (e.key === 'Backspace') {
        s.onChange(s.value.slice(0, -1));
        e.preventDefault();
      } else if (e.key === 'Enter' && s.value.length >= s.minLength) {
        s.onSubmit?.();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboard]);

  const press = (d: string): void => {
    if (!disabled && value.length < maxLength) onChange(value + d);
  };

  const dots = Math.max(maxLength, value.length);
  return (
    <div className="flex flex-col gap-4" dir="ltr">
      <div className="pin-dots" aria-hidden="true">
        {Array.from({ length: dots }, (_, i) => (
          <span key={i} className="pin-dot" data-filled={i < value.length} />
        ))}
      </div>
      <div className="sr-only" aria-live="polite">
        {t('pin.entered', { n: value.length })}
      </div>
      <div className="pin-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            className="pin-key"
            disabled={disabled}
            onClick={() => press(d)}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          className="pin-key fn"
          disabled={disabled || value.length === 0}
          onClick={() => onChange('')}
        >
          {t('pin.clear')}
        </button>
        <button type="button" className="pin-key" disabled={disabled} onClick={() => press('0')}>
          0
        </button>
        <button
          type="button"
          className="pin-key fn"
          aria-label={t('pin.backspace')}
          disabled={disabled || value.length === 0}
          onClick={() => onChange(value.slice(0, -1))}
        >
          <Delete size={22} className="mx-auto" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
