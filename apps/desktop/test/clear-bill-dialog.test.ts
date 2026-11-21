import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ClearBillDialog } from '../src/screens/Billing';

describe('ClearBillDialog', () => {
  it('focuses Cancel, not the danger button, so a scanner Enter cannot wipe the bill (S5)', () => {
    const html = renderToStaticMarkup(
      createElement(ClearBillDialog, {
        open: true,
        onClose: () => undefined,
        onClear: () => undefined,
      }),
    );
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    const focused = buttons.filter((b) => b.includes('data-autofocus'));
    expect(focused).toHaveLength(1);
    expect(focused[0]).not.toContain('btn-danger');
    expect(buttons.some((b) => b.includes('btn-danger'))).toBe(true);
  });
});
