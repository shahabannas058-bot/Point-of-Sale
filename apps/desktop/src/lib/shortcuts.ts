import { useEffect, useRef } from 'react';

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

export interface HotkeyOptions {
  /**
   * Screen-level shortcuts set this so F9 / F7 / Ctrl+D never act on the cart behind an open
   * dialog. Dialog-local hotkeys (Ctrl+Enter in the pay dialog) leave it off. Escape still
   * closes the dialog: the native <dialog> handles it itself.
   */
  blockWhileDialogOpen?: boolean;
}

/** Where the key landed: in a form field, and whether any modal <dialog> is open. */
export interface KeyContext {
  typing: boolean;
  dialogOpen: boolean;
}

export interface HotkeyDecision {
  fire: boolean;
  preventDefault: boolean;
}

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
const F_KEY = /^F\d+$/;

const SKIP: HotkeyDecision = { fire: false, preventDefault: false };

export const isAnyDialogOpen = (): boolean => document.querySelector('dialog[open]') !== null;

/**
 * Pure matcher. While focus is in a form field only Escape, Ctrl+* / Alt+* and F-keys fire, so typing
 * "+" in a qty box never triggers the "+" shortcut. With `blockWhileDialogOpen` nothing fires
 * while a dialog is open. F-keys, Ctrl and Alt combos that fire also swallow the browser default.
 */
export function resolveHotkey(
  spec: string,
  ctx: KeyContext,
  opts: HotkeyOptions = {},
): HotkeyDecision {
  if (opts.blockWhileDialogOpen && ctx.dialogOpen) return SKIP;
  const chord = F_KEY.test(spec) || spec.startsWith('Ctrl+') || spec.startsWith('Alt+');
  const alwaysOk = chord || spec === 'Escape';
  if (ctx.typing && !alwaysOk) return SKIP;
  return { fire: true, preventDefault: chord };
}

/** Global key handler; see resolveHotkey for which keys fire where. */
export function useHotkeys(map: HotkeyMap, enabled = true, opts: HotkeyOptions = {}): void {
  const ref = useRef(map);
  ref.current = map;
  const block = opts.blockWhileDialogOpen === true;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      const spec = specOf(e);
      const fn = ref.current[spec];
      if (!fn) return;
      const el = e.target as HTMLElement | null;
      const typing = el !== null && (TYPING_TAGS.has(el.tagName) || el.isContentEditable);
      const decision = resolveHotkey(
        spec,
        { typing, dialogOpen: isAnyDialogOpen() },
        { blockWhileDialogOpen: block },
      );
      if (!decision.fire) return;
      if (decision.preventDefault) e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, block]);
}
