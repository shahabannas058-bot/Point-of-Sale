import { useEffect, useRef } from 'react';

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

/** Key spec examples: "F2", "Ctrl+Enter", "Ctrl+D", "Escape", "Delete", "+", "-", "ArrowUp". */
export function specOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  return parts.join('+');
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Global key handler. While focus is in a form field only Escape, Ctrl+* and F-keys fire,
 * so typing "+" in a qty box never triggers the "+" shortcut. Keys listed in `allowWhileTyping` also fire.
 */
export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      const spec = specOf(e);
      const fn = ref.current[spec];
      if (!fn) return;
      const el = e.target as HTMLElement | null;
      const typing = el !== null && (TYPING_TAGS.has(el.tagName) || el.isContentEditable);
      const alwaysOk = /^F\d+$/.test(spec) || spec === 'Escape' || spec.startsWith('Ctrl+');
      if (typing && !alwaysOk) return;
      if (/^F\d+$/.test(spec) || spec.startsWith('Ctrl+')) e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
