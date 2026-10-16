import { useEffect, useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { ApprovalReason } from '@pos/shared';
import { dynKey, useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { useService } from '../service/context';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { PinPad } from './ui/PinPad';

/** Manager/owner PIN -> single-use approval token (valid 60 s). */
export function ApprovalDialog({
  open,
  reason,
  onClose,
  onGranted,
}: {
  open: boolean;
  reason: ApprovalReason;
  onClose: () => void;
  onGranted: (token: string) => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPin('');
      setError(null);
    }
  }, [open]);

  const submit = async (): Promise<void> => {
    if (pin.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const grant = await service.auth.requestApproval(pin);
      onGranted(grant.token);
    } catch (e) {
      setError(errorMessage(e, t));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={380}
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck size={20} aria-hidden="true" />
          {t('approval.title')}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={pin.length < 4}
            loading={busy}
            onClick={() => void submit()}
          >
            {t('approval.approve')}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-muted">
        {t('approval.hint', { reason: t(dynKey('approval.reason', reason)) })}
      </p>
      <PinPad value={pin} onChange={setPin} onSubmit={() => void submit()} disabled={busy} />
      <div
        role="alert"
        className="mt-3 min-h-6 text-center text-sm font-medium text-[var(--danger-ink)]"
      >
        {error}
      </div>
    </Dialog>
  );
}
