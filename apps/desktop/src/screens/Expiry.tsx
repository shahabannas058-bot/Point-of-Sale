import { useEffect, useState, type ReactNode } from 'react';
import { PackageX } from 'lucide-react';
import type { BatchView } from '@pos/shared';
import { Badge, type Tone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input } from '../components/ui/Field';
import { Empty, ErrorBox, PageHeader, SkeletonRows, Tabs } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { qtyText } from '../lib/qty';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { useCan } from '../store/session';
import { toast } from '../store/toast';

type Window = 'all' | '7' | '30';
const WINDOWS: readonly Window[] = ['all', '7', '30'];

/** Red when expired or expiring today, amber within a week, green otherwise. */
const toneOf = (daysLeft: number): Tone =>
  daysLeft <= 0 ? 'danger' : daysLeft <= 7 ? 'warning' : 'success';

function WriteOffDialog({
  batch,
  onClose,
}: {
  batch: BatchView | null;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (batch) {
      setReason(t('expiry.reasonDefault'));
      setError(null);
    }
    // the reason is only reset when a different batch is opened, not when the language changes
  }, [batch?.id]);

  const save = async (): Promise<void> => {
    if (!batch || busy || reason.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await service.batches.writeOff({ batchId: batch.id, reason: reason.trim() });
      bump();
      toast.success(t('expiry.writtenOff'));
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={batch !== null}
      onClose={onClose}
      width={460}
      dismissable={!busy}
      title={t('expiry.writeOffTitle')}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={reason.trim() === ''}
            onClick={() => void save()}
          >
            {t('expiry.writeOff')}
          </Button>
        </>
      }
    >
      {batch ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm">
            {t('expiry.writeOffText', {
              qty: qtyText(batch.onHand, batch.unitScale, batch.unitLabel),
              item: batch.label,
            })}
          </p>
          <Field label={t('expiry.reason')}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
          <div role="alert" className="min-h-5 text-sm font-medium text-[var(--danger-ink)]">
            {error}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

export function Expiry(): ReactNode {
  const t = useT();
  const can = useCan();
  const [win, setWin] = useState<Window>('30');
  const [writeOff, setWriteOff] = useState<BatchView | null>(null);
  const list = useServiceQuery(
    (s) => s.batches.list(win === 'all' ? {} : { withinDays: Number(win) }),
    [win],
  );
  const rows = list.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('nav.expiry')} subtitle={t('expiry.subtitle')} />
      <Tabs<Window>
        label={t('nav.expiry')}
        value={win}
        onChange={setWin}
        items={WINDOWS.map((w) => ({ value: w, label: t(dynKey('expiry.win', w)) }))}
      />
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : (
        <div className="tbl-wrap">
          {list.loading && !list.data ? (
            <SkeletonRows rows={5} />
          ) : rows.length === 0 ? (
            <Empty
              icon={<PackageX size={28} aria-hidden="true" />}
              title={t('expiry.none')}
              hint={t('expiry.noneHint')}
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('billing.item')}</th>
                  <th>{t('expiry.batch')}</th>
                  <th>{t('expiry.expires')}</th>
                  <th className="num">{t('expiry.inStock')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td className="font-medium">{b.label}</td>
                    <td className="ltr text-sm">{b.batchNo ?? t('expiry.noBatchNo')}</td>
                    <td>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="ltr num text-sm">{b.expiryDate}</span>
                        <Badge tone={toneOf(b.daysLeft)}>
                          {b.daysLeft < 0
                            ? t('expiry.expired')
                            : b.daysLeft === 0
                              ? t('expiry.today')
                              : t('expiry.inDays', { n: b.daysLeft })}
                        </Badge>
                      </div>
                    </td>
                    <td className="num">
                      <b>{qtyText(b.onHand, b.unitScale, b.unitLabel)}</b>
                    </td>
                    <td>
                      {can('adjust_stock') ? (
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant={b.daysLeft < 0 ? 'primary' : 'secondary'}
                            onClick={() => setWriteOff(b)}
                          >
                            {t('expiry.writeOff')}
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <WriteOffDialog batch={writeOff} onClose={() => setWriteOff(null)} />
    </div>
  );
}
