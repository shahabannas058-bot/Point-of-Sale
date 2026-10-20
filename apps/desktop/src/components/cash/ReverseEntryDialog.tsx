import { useEffect, useState, type ReactNode } from 'react';
import type { CashEntryView } from '@pos/shared';
import { dynKey, useT } from '../../i18n';
import { errorMessage } from '../../i18n/errors';
import { useBusyAction } from '../../lib/busy-action';
import { useService } from '../../service/context';
import { useDataVersion } from '../../store/data-version';
import { toast } from '../../store/toast';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Field';
import { Money } from '../ui/misc';

/** Cancels a cash book entry with an opposite entry (manager / owner). */
export function ReverseEntryDialog({
  entry,
  onClose,
}: {
  entry: CashEntryView | null;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (entry) {
      setReason('');
      setError(null);
    }
  }, [entry]);

  const { busy, run: save } = useBusyAction(async (): Promise<void> => {
    if (!entry) return;
    setError(null);
    try {
      await service.cash.reverseEntry({ entryId: entry.id, reason: reason.trim() || null });
      bump();
      toast.success(t('cash.reversedDone'));
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    }
  });

  return (
    <Dialog
      open={entry !== null}
      onClose={onClose}
      width={420}
      dismissable={!busy}
      title={t('cash.reverseTitle')}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void save()}>
            {t('cash.reverse')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
          {entry ? (
            <p className="flex items-center justify-between gap-2 font-semibold">
              <span>
                {entry.category
                  ? t(dynKey('cash.cat', entry.category))
                  : t(dynKey('cash.type', entry.type))}
              </span>
              <Money value={entry.amount} />
            </p>
          ) : null}
          <p className="text-sm text-muted">{t('cash.reverseHint')}</p>
          <Field label={t('cash.reason')}>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              data-autofocus
            />
          </Field>
          <div role="alert" className="min-h-5 text-sm font-medium text-[var(--danger-ink)]">
            {error}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
