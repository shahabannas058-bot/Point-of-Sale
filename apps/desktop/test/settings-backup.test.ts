import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { hasPermission, type PosService, type Role } from '@pos/shared';
import { translate } from '../src/i18n';
import { Settings } from '../src/screens/Settings';
import { RuntimeProvider } from '../src/service/context';

// zustand renders its initial state on the server, so the signed-in role is mocked at useCan
const signedIn = vi.hoisted((): { role: Role } => ({ role: 'owner' }));
vi.mock('../src/store/session', () => ({
  useCan: () => (p: Parameters<typeof hasPermission>[1]) => hasPermission(signedIn.role, p),
}));

const pending = (): Promise<never> => new Promise<never>(() => undefined);
const service = new Proxy({}, { get: () => new Proxy({}, { get: () => pending }) }) as PosService;

function settingsAs(role: Role): string {
  signedIn.role = role;
  return renderToStaticMarkup(
    createElement(RuntimeProvider, {
      runtime: {
        service,
        loadDemo: pending,
        exportBytes: () => new Uint8Array(),
        restore: pending,
      },
      children: createElement(Settings),
    }),
  );
}

describe('Settings: database export and restore (S14)', () => {
  const exportText = translate('en', 'settings.exportDb');
  const restoreText = translate('en', 'settings.restoreDb');

  it('the owner sees export and restore', () => {
    const html = settingsAs('owner');
    expect(html).toContain(exportText);
    expect(html).toContain(restoreText);
  });

  it('a cashier sees neither: the file holds every PIN hash', () => {
    const html = settingsAs('cashier');
    expect(html).not.toContain(exportText);
    expect(html).not.toContain(restoreText);
  });
});
