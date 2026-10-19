import { useRef, useState, type ReactNode } from 'react';
import { Upload } from 'lucide-react';
import { useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { useBusyAction } from '../lib/busy-action';
import { useRuntime } from '../service/context';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Input } from './ui/Field';

const CONFIRM_WORD = 'RESTORE';

/**
 * "Restore backup" for the Settings > Backup section: pick a .sqlite / .db file, type RESTORE, and the whole
 * database is replaced and the app reloads. Where the runtime cannot restore (the desktop shell owns pos.db) only a
 * note is shown.
 */
export function RestoreBackup(): ReactNode {
  const t = useT();
  const rt = useRuntime();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [word, setWord] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { busy, run: restore } = useBusyAction(async (): Promise<void> => {
    if (file === null || rt.restore === undefined) return;
    try {
      await rt.restore(new Uint8Array(await file.arrayBuffer()));
      // no hash change before the reload: the router would mount Login against the already closed database
      window.location.reload();
    } catch (e) {
      setError(errorMessage(e, t));
    }
  });

  if (rt.restore === undefined)
    return <p className="text-sm text-muted">{t('settings.restoreUnavailable')}</p>;

  const pick = (chosen: File | null): void => {
    setFile(chosen);
    setWord('');
    setError(null);
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".sqlite,.db,application/octet-stream"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const chosen = e.target.files?.[0] ?? null;
          e.target.value = '';
          if (chosen) pick(chosen);
        }}
      />
      <Button
        variant="danger-outline"
        className="self-start"
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={16} aria-hidden="true" />
        {t('settings.restoreDb')}
      </Button>
      <p className="text-sm text-muted">{t('settings.restoreHint')}</p>
      <Dialog
        open={file !== null}
        onClose={() => pick(null)}
        width={440}
        dismissable={!busy}
        title={t('settings.restoreDb')}
        footer={
          <>
            <Button onClick={() => pick(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={word.trim().toUpperCase() !== CONFIRM_WORD}
              loading={busy}
              onClick={() => void restore()}
            >
              {t('settings.restoreDb')}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm">{t('settings.restoreConfirm', { file: file?.name ?? '' })}</p>
        <Input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          className="ltr"
          placeholder={CONFIRM_WORD}
          aria-label={CONFIRM_WORD}
          data-autofocus
        />
        {error ? (
          <div role="alert" className="mt-3 text-sm font-medium text-[var(--danger-ink)]">
            {error}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
