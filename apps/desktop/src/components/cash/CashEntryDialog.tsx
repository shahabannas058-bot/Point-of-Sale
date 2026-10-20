import { useEffect, useState, type ReactNode } from 'react';
import {
  CASH_ENTRY_TYPES,
  EXPENSE_CATEGORIES,
  type CashEntryType,
  type ExpenseCategory,
} from '@pos/shared';
import { dynKey, useT } from '../../i18n';
import { errorMessage } from '../../i18n/errors';
import { useBusyAction } from '../../lib/busy-action';
import { parseRupees } from '../../lib/money';
import { useService } from '../../service/context';
import { useDataVersion } from '../../store/data-version';
import { toast } from '../../store/toast';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Select } from '../ui/Field';

/** Records an expense, or cash put into / taken out of the drawer. `startType` picks the first choice. */
export function CashEntryDialog({
  open,
  startType,
  onClose,
}: {
  open: boolean;
  startType: CashEntryType;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [type, setType] = useState<CashEntryType>(startType);
  const [category, setCategory] = useState<ExpenseCategory>('tea_food');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setType(startType);
      setCategory('tea_food');
      setAmount('');
      setNote('');
      setError(null);
    }
  }, [open, startType]);
  const value = parseRupees(amount);
  const invalid = value === null || value <= 0;

  const { busy, run: save } = useBusyAction(async (): Promise<void> => {
    if (invalid) return;
    setError(null);
    try {
      await service.cash.addEntry({
        type,
        category: type === 'expense' ? category : null,
        amount: value,
        note: note.trim() || null,
      });
      bump();
      toast.success(t('cash.saved'));
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    }
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={440}
      dismissable={!busy}
      title={type === 'expense' ? t('cash.addExpense') : t('cash.cashInOut')}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={invalid} loading={busy} onClick={() => void save()}>
            {t('common.save')}
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
          <Field label={t('cash.type')}>
            <Select value={type} onChange={(e) => setType(e.target.value as CashEntryType)}>
              {CASH_ENTRY_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(dynKey('cash.type', x))}
                </option>
              ))}
            </Select>
          </Field>
          {type === 'expense' ? (
            <Field label={t('cash.category')}>
              <Select
                value={category}
                onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(dynKey('cash.cat', c))}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label={t('pay.amount')} error={amount && invalid ? t('cash.amountInvalid') : null}>
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="ltr text-lg font-semibold"
              data-autofocus
              invalid={!!amount && invalid}
            />
          </Field>
          <Field label={t('cash.note')}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          <div role="alert" className="min-h-5 text-sm font-medium text-[var(--danger-ink)]">
            {error}
          </div>
          <button type="submit" className="sr-only" tabIndex={-1}>
            {t('common.save')}
          </button>
        </fieldset>
      </form>
    </Dialog>
  );
}
