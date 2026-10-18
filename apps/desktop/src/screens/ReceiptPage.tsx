import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Printer } from 'lucide-react';
import { ReceiptPreview } from '../components/Receipt';
import { Button } from '../components/ui/Button';
import { ErrorBox, SkeletonRows } from '../components/ui/misc';
import { useT } from '../i18n';
import { printReceipt } from '../lib/print';
import { loadReceiptModel, type ReceiptModel } from '../lib/receipt-model';
import { useService } from '../service/context';

/** Route /receipt/:id — print view of a stored invoice (idempotent: reprints never change data). */
export function ReceiptPage(): ReactNode {
  const t = useT();
  const { id = '' } = useParams();
  const service = useService();
  const [model, setModel] = useState<ReceiptModel | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    loadReceiptModel(service, id)
      .then((m) => live && setModel(m))
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [id, service]);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 p-6">
      <div className="no-print flex items-center justify-between">
        <Link
          to="/sales"
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary-ink"
        >
          <ArrowLeft size={16} className="rtl:-scale-x-100" aria-hidden="true" />
          {t('nav.sales')}
        </Link>
        <Button
          variant="primary"
          disabled={!model}
          onClick={() => model && void printReceipt(model)}
        >
          <Printer size={16} aria-hidden="true" />
          {t('receipt.print')}
        </Button>
      </div>
      {error ? (
        <ErrorBox error={error} />
      ) : model ? (
        <ReceiptPreview model={model} />
      ) : (
        <SkeletonRows rows={8} />
      )}
    </div>
  );
}
