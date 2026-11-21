import { useState, type ReactNode } from 'react';
import { Download, RotateCcw } from 'lucide-react';
import { useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { downloadFile } from '../lib/download';
import { isWebView2 } from '../native/webview-bridge';
import { BrandMark } from './BrandMark';
import { RestoreBackupControl } from './RestoreBackup';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Input } from './ui/Field';

const RESET_WORD = 'RESET';

/**
 * Boot screen for a database that migration 0009 refused because it still holds mobile-shop data (phones, repairs).
 * Nothing was changed. In the browser the shopkeeper can keep a copy, restore a backup or start fresh (the same
 * restore and reset the Settings screen offers); in the desktop shell C# owns pos.db, so only the message is shown.
 */
export function UpgradeRefused({ error }: { error: unknown }): ReactNode {
  const t = useT();
  const inShell = isWebView2();
  const [resetOpen, setResetOpen] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const download = async (): Promise<void> => {
    setProblem(null);
    try {
      const { readStoredBrowserDb } = await import('../db/browser-db');
      const bytes = await readStoredBrowserDb();
      if (!bytes) return setProblem(t('boot.legacyNoCopy'));
      const name = `pos-mobile-shop-${new Date().toISOString().slice(0, 10)}.sqlite`;
      downloadFile(name, bytes, 'application/octet-stream');
    } catch (e) {
      setProblem(errorMessage(e, t));
    }
  };

  const restore = async (bytes: Uint8Array): Promise<void> => {
    const { restoreBrowserDb } = await import('../db/browser-db');
    await restoreBrowserDb(bytes);
  };

  const reset = async (): Promise<void> => {
    setBusy(true);
    try {
      const { resetBrowserDb } = await import('../db/browser-db');
      await resetBrowserDb();
      window.location.hash = '#/login';
      window.location.reload();
    } catch (e) {
      setProblem(errorMessage(e, t));
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-6">
      <div className="flex max-w-lg flex-col items-center gap-3 text-center">
        <BrandMark size={64} />
        <h1 className="text-xl">{t('boot.legacyTitle')}</h1>
        <p className="text-sm">{t('boot.legacyHint')}</p>
        {inShell ? (
          <p className="text-sm text-muted">{t('boot.legacyShell')}</p>
        ) : (
          <>
            <p className="text-sm text-muted">{t('boot.legacyNext')}</p>
            <div className="flex flex-col items-center gap-2">
              <Button onClick={() => void download()}>
                <Download size={16} aria-hidden="true" />
                {t('boot.legacyDownload')}
              </Button>
              <RestoreBackupControl restore={restore} />
              <Button
                variant="danger-outline"
                onClick={() => {
                  setWord('');
                  setResetOpen(true);
                }}
              >
                <RotateCcw size={16} aria-hidden="true" />
                {t('boot.legacyReset')}
              </Button>
            </div>
          </>
        )}
        {problem ? (
          <div role="alert" className="text-sm font-medium text-[var(--danger-ink)]">
            {problem}
          </div>
        ) : null}
        <p className="ltr text-xs text-muted">
          {error instanceof Error ? error.message : String(error)}
        </p>
      </div>
      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        width={440}
        dismissable={!busy}
        title={t('boot.legacyReset')}
        footer={
          <>
            <Button onClick={() => setResetOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={word.trim().toUpperCase() !== RESET_WORD}
              loading={busy}
              onClick={() => void reset()}
            >
              {t('boot.legacyReset')}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm">{t('boot.legacyResetConfirm')}</p>
        <Input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          className="ltr"
          placeholder={RESET_WORD}
          aria-label={RESET_WORD}
          data-autofocus
        />
      </Dialog>
    </div>
  );
}
