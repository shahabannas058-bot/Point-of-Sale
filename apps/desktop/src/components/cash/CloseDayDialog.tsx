import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { errorMessage } from '../../i18n/errors';
import { useBusyAction } from '../../lib/busy-action';
import { closeInputError } from '../../lib/cash';
import { formatRs, paisaToInput, parseRupees } from '../../lib/money';
import { useService } from '../../service/context';
import { useDataVersion } from '../../store/data-version';
import { toast } from '../../store/toast';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Field';
import { Money } from '../ui/misc';

/** "Short by Rs 100" / "Extra Rs 50" / "Exact match" for counted - expected. */
export function DifferenceBadge({ value }: { value: number }): ReactNode {
  const t = useT();
  if (value === 0) return <Badge tone="success">{t('cash.exact')}</Badge>;
  const amount = formatRs(Math.abs(value));
  return value < 0 ? (
    <Badge tone="danger">{t('cash.short', { amount })}</Badge>
  ) : (
    <Badge tone="warning">{t('cash.extra', { amount })}</Badge>
  );
}

/** Count the drawer, see the difference live, choose what stays for tomorrow, then close. */
export function CloseDayDialog({
  open,
  expected,
  lastCarried,
  onClose,
}: {
  open: boolean;
  expected: number;
  /** What the previous close left in the drawer: a good default for tomorrow's float. */
  lastCarried: number;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [counted, setCounted] = useState('');
  const [carried, setCarried] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCounted('');
      setCarried(paisaToInput(lastCarried));
      setNote('');
      setError(null);
    }
  }, [open, lastCarried]);
  const countedValue = counted.trim() ? parseRupees(counted) : null;
  const carriedValue = carried.trim() ? parseRupees(carried) : 0;
  const inputError = closeInputError(countedValue, carriedValue);

  const { busy, run: save } = useBusyAction(async (): Promise<void> => {
    if (inputError !== null || countedValue === null || carriedValue === null) return;
    setError(null);
    try {
      await service.cash.closeDay({
        counted: countedValue,
        carriedForward: carriedValue,
        note: note.trim() || null,
      });
      bump();
      toast.success(t('cash.closed'));
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    }
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={460}
      dismissable={!busy}
      title={t('cash.closeTitle')}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={inputError !== null}
            loading={busy}
            onClick={() => void save()}
          >
            {t('cash.closeDay')}
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
          <p className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted">{t('cash.expected')}</span>
            <Money value={expected} className="text-lg font-bold" />
          </p>
          <Field
            label={t('cash.counted')}
            error={counted && inputError === 'counted' ? t('cash.countedInvalid') : null}
          >
            <Input
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              inputMode="decimal"
              className="ltr text-lg font-semibold"
              data-autofocus
              invalid={!!counted && inputError === 'counted'}
            />
          </Field>
          {countedValue !== null && countedValue >= 0 ? (
            <p className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted">{t('cash.difference')}</span>
              <DifferenceBadge value={countedValue - expected} />
            </p>
          ) : null}
          <Field
            label={t('cash.carried')}
            error={inputError === 'carried' && counted ? t('cash.carriedInvalid') : null}
            hint={
              countedValue !== null && carriedValue !== null && inputError === null
                ? t('cash.carriedHint', { amount: formatRs(countedValue - carriedValue) })
                : null
            }
          >
            <Input
              value={carried}
              onChange={(e) => setCarried(e.target.value)}
              inputMode="decimal"
              className="ltr"
              invalid={inputError === 'carried' && !!counted}
            />
          </Field>
          <Field label={t('cash.note')}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          <div role="alert" className="min-h-5 text-sm font-medium text-[var(--danger-ink)]">
            {error}
          </div>
          <button type="submit" className="sr-only" tabIndex={-1}>
            {t('cash.closeDay')}
          </button>
        </fieldset>
      </form>
    </Dialog>
  );
}
