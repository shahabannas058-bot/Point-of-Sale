import { useRef, useState, type ReactNode } from 'react';
import { Download, KeyRound, RotateCcw } from 'lucide-react';
import { legacyActions } from '../db/legacy-gate';
import { useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { downloadFile } from '../lib/download';
import { BrandMark } from './BrandMark';
import { RestoreBackupControl } from './RestoreBackup';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Field, Input } from './ui/Field';
import { PIN_LENGTH } from './ui/PinPad';

const RESET_WORD = 'RESET';

/**
 * Boot screen for a database that migration 0009 refused because it still holds mobile-shop data (phones, repairs).
 * Nothing was changed. The shopkeeper can keep a copy, restore a backup or start fresh (the same restore and reset
 * the Settings screen offers) once the owner PIN of the stored database is checked; start fresh also needs a copy
 * downloaded first (legacy-gate.ts). Browser only: the desktop shell migrates pos.db before the page loads and shows
 * its own message when 0009 is refused.
 */
export function UpgradeRefused({ error }: { error: unknown }): ReactNode {
  const t = useT();
  const [pin, setPin] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const check = useRef<Promise<((pin: string) => Promise<void>) | null> | null>(null);
  const actions = legacyActions({ unlocked, downloaded });
  const [resetOpen, setResetOpen] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const unlock = async (): Promise<void> => {
    if (pin.length !== PIN_LENGTH || checking) return;
    setChecking(true);
    setProblem(null);
    try {
      // one checker for the screen, so wrong PINs lock it out like the login screen
      check.current ??= import('../db/browser-db').then((m) => m.storedOwnerPinCheck());
      const verify = await check.current;
      if (!verify) return setProblem(t('boot.legacyNoCopy'));
      await verify(pin);
      setUnlocked(true);
    } catch (e) {
      setProblem(errorMessage(e, t));
    } finally {
      setPin('');
      setChecking(false);
    }
  };

  const download = async (): Promise<void> => {
    if (!actions.download) return;
    setProblem(null);
    try {
      const { readStoredBrowserDb } = await import('../db/browser-db');
      const bytes = await readStoredBrowserDb();
      if (!bytes) return setProblem(t('boot.legacyNoCopy'));
      const name = `pos-mobile-shop-${new Date().toISOString().slice(0, 10)}.sqlite`;
      downloadFile(name, bytes, 'application/octet-stream');
      setDownloaded(true);
    } catch (e) {
      setProblem(errorMessage(e, t));
    }
  };

  const restore = async (bytes: Uint8Array): Promise<void> => {
    const { restoreBrowserDb } = await import('../db/browser-db');
    await restoreBrowserDb(bytes);
  };

  const reset = async (): Promise<void> => {
    if (!actions.reset) return;
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
        <p className="text-sm text-muted">{t('boot.legacyNext')}</p>
        {unlocked ? (
          <div className="flex flex-col items-center gap-2">
            <Button onClick={() => void download()}>
              <Download size={16} aria-hidden="true" />
              {t('boot.legacyDownload')}
            </Button>
            {actions.restore ? <RestoreBackupControl restore={restore} /> : null}
            <Button
              variant="danger-outline"
              disabled={!actions.reset}
              title={actions.reset ? undefined : t('boot.legacyResetNeedsCopy')}
              onClick={() => {
                setWord('');
                setResetOpen(true);
              }}
            >
              <RotateCcw size={16} aria-hidden="true" />
              {t('boot.legacyReset')}
            </Button>
            {actions.reset ? null : (
              <p className="text-xs text-muted">{t('boot.legacyResetNeedsCopy')}</p>
            )}
          </div>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void unlock();
            }}
          >
            <Field label={t('boot.legacyOwnerPin')}>
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PIN_LENGTH}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                className="ltr w-32 text-center"
              />
            </Field>
            <Button type="submit" loading={checking} disabled={pin.length !== PIN_LENGTH}>
              <KeyRound size={16} aria-hidden="true" />
              {t('boot.legacyUnlock')}
            </Button>
          </form>
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
