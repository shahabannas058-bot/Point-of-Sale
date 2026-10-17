import { useEffect, useState, type ReactNode } from 'react';
import { Printer } from 'lucide-react';
import { useT } from '../i18n';
import { printReceipt } from '../lib/print';
import { useHotkeys } from '../lib/shortcuts';
import { loadReceiptModel, type ReceiptModel } from '../lib/receipt-model';
import { useService } from '../service/context';
import { usePrefs, type ReceiptLang, type ReceiptWidth } from '../store/prefs';
import { ReceiptPreview } from './Receipt';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { ErrorBox, SkeletonRows } from './ui/misc';

export function ReceiptDialog({
  invoiceId,
  onClose,
  closeLabel,
}: {
  invoiceId: string | null;
  onClose: () => void;
  closeLabel?: string;
}): ReactNode {
  const t = useT();
  const service = useService();
  const [model, setModel] = useState<ReceiptModel | null>(null);
  const [error, setError] = useState<unknown>(null);
  const width = usePrefs((s) => s.receiptWidth);
  const setWidth = usePrefs((s) => s.setReceiptWidth);
  const lang = usePrefs((s) => s.receiptLang);
  const setLang = usePrefs((s) => s.setReceiptLang);

  useHotkeys(
    {
      'Ctrl+P': () => {
        if (model) void printReceipt(model);
      },
    },
    invoiceId !== null,
  );

  useEffect(() => {
    if (!invoiceId) return;
    setModel(null);
    setError(null);
    let live = true;
    loadReceiptModel(service, invoiceId)
      .then((m) => live && setModel(m))
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [invoiceId, service]);

  return (
    <Dialog
      open={invoiceId !== null}
      onClose={onClose}
      width={440}
      title={t('receipt.title')}
      footer={
        <>
          <Button onClick={onClose}>{closeLabel ?? t('common.close')}</Button>
          <Button
            variant="primary"
            disabled={!model}
            onClick={() => model && void printReceipt(model)}
            data-autofocus
          >
            <Printer size={16} aria-hidden="true" />
            {t('receipt.print')}
            <span className="kbd">Ctrl+P</span>
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="seg" role="group" aria-label={t('settings.receiptWidth')}>
          {(['58', '80'] as ReceiptWidth[]).map((w) => (
            <button key={w} type="button" aria-pressed={width === w} onClick={() => setWidth(w)}>
              {w} mm
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label={t('settings.receiptLang')}>
          {(['en', 'ur', 'both'] as ReceiptLang[]).map((l) => (
            <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
              {l === 'en' ? 'English' : l === 'ur' ? 'Roman Urdu' : 'EN + Roman Urdu'}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[60dvh] overflow-auto rounded-lg bg-surface-2 p-3">
        {error ? (
          <ErrorBox error={error} />
        ) : model ? (
          <ReceiptPreview model={model} />
        ) : (
          <SkeletonRows rows={8} />
        )}
      </div>
    </Dialog>
  );
}
