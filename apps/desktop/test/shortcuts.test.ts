import { describe, expect, it } from 'vitest';
import { resolveHotkey } from '../src/lib/shortcuts';

const screen = { blockWhileDialogOpen: true };
const noDialog = { typing: false, dialogOpen: false };
const typing = { typing: true, dialogOpen: false };
const inDialog = { typing: true, dialogOpen: true };

describe('resolveHotkey', () => {
  it('fires plain keys only outside form fields', () => {
    expect(resolveHotkey('+', noDialog).fire).toBe(true);
    expect(resolveHotkey('+', typing).fire).toBe(false);
    expect(resolveHotkey('Delete', typing).fire).toBe(false);
  });

  it('lets F-keys, Ctrl combos and Escape fire while typing', () => {
    expect(resolveHotkey('F9', typing)).toEqual({ fire: true, preventDefault: true });
    expect(resolveHotkey('Ctrl+D', typing)).toEqual({ fire: true, preventDefault: true });
    expect(resolveHotkey('Escape', typing)).toEqual({ fire: true, preventDefault: false });
  });

  it('lets Alt combos fire while typing, so Alt+1 adds a quick item from the search box', () => {
    expect(resolveHotkey('Alt+1', typing)).toEqual({ fire: true, preventDefault: true });
  });

  it('blocks every screen shortcut while a dialog is open', () => {
    for (const spec of ['F4', 'F7', 'F8', 'F9', 'Ctrl+D', 'Ctrl+P', 'Delete', '+', 'Escape']) {
      expect(resolveHotkey(spec, inDialog, screen), spec).toEqual({
        fire: false,
        preventDefault: false,
      });
    }
  });

  it('does not block dialog-local shortcuts (Ctrl+Enter inside the pay dialog)', () => {
    expect(resolveHotkey('Ctrl+Enter', inDialog).fire).toBe(true);
    expect(resolveHotkey('Ctrl+P', { typing: false, dialogOpen: true }).fire).toBe(true);
  });

  it('screen shortcuts still fire when no dialog is open', () => {
    expect(resolveHotkey('F9', typing, screen).fire).toBe(true);
    expect(resolveHotkey('Escape', noDialog, screen).fire).toBe(true);
  });
});
