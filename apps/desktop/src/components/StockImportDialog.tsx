import { useRef, useState, type ReactNode } from 'react';
import { Download, Upload } from 'lucide-react';
import { formatQuantity, unitScaleFor } from '@pos/shared';
import { dynKey, useT, type TFn } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { useBusyAction } from '../lib/busy-action';
import { downloadFile } from '../lib/download';
import { formatAmount } from '../lib/money';
import {
  IMPORT_TEMPLATE_CSV,
  MAX_IMPORT_ROWS,
  PREVIEW_ROWS,
  runStockImport,
  toImportRows,
  type ImportParse,
  type ImportProblem,
  type ImportResult,
  type ImportRow,
} from '../lib/stock-import';
import { useService } from '../service/context';
import { useShopModules } from '../service/use-modules';
import { useDataVersion } from '../store/data-version';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

const MAX_PROBLEMS_SHOWN = 100;

interface Loaded {
  fileName: string;
  parse: ImportParse;
}

const problemText = (p: ImportProblem, t: TFn): string =>
  `${t('import.line', { line: p.line })} · ${p.field}: ${t(dynKey('import.problem', p.code), {
    field: p.field,
    max: MAX_IMPORT_ROWS,
  })}`;

function ProblemList({ problems }: { problems: readonly ImportProblem[] }): ReactNode {
  const t = useT();
  if (problems.length === 0) return null;
  const shown = problems.slice(0, MAX_PROBLEMS_SHOWN);
  return (
    <div className="mt-3">
      <p className="text-sm font-medium text-[var(--danger-ink)]">
        {t('import.skipped', { n: problems.length })}
      </p>
      <ul className="mt-1 max-h-40 overflow-auto text-xs text-muted">
        {shown.map((p) => (
          <li key={`${p.line}-${p.field}`}>{problemText(p, t)}</li>
        ))}
        {problems.length > shown.length ? (
          <li>{t('import.previewMore', { n: problems.length - shown.length })}</li>
        ) : null}
      </ul>
    </div>
  );
}

function PreviewTable({ rows }: { rows: readonly ImportRow[] }): ReactNode {
  const t = useT();
  const shown = rows.slice(0, PREVIEW_ROWS);
  const qty = (r: ImportRow, n: number): string =>
    `${formatQuantity(n, unitScaleFor(r.unit))}${r.unit === 'pcs' ? '' : ` ${r.unit}`}`;
  return (
    <div className="tbl-wrap max-h-72 overflow-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>#</th>
            <th>{t('inv.brand')}</th>
            <th>{t('inv.product')}</th>
            <th>SKU</th>
            <th>{t('inv.barcode')}</th>
            <th>{t('import.unit')}</th>
            <th className="num">{t('inv.cost')}</th>
            <th className="num">{t('inv.price')}</th>
            <th className="num">{t('inv.openingQty')}</th>
            <th className="num">{t('inv.reorder')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.line}>
              <td className="text-muted">{r.line}</td>
              <td>{r.brand}</td>
              <td className="font-semibold">{r.name}</td>
              <td className="ltr font-mono text-xs">{r.sku}</td>
              <td className="ltr font-mono text-xs">{r.barcode ?? '—'}</td>
              <td>{r.unit}</td>
              <td className="num">{formatAmount(r.costPrice)}</td>
              <td className="num">{formatAmount(r.salePrice)}</td>
              <td className="num">{qty(r, r.openingQty)}</td>
              <td className="num">{qty(r, r.reorderLevel)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length ? (
        <p className="p-2 text-xs text-muted">
          {t('import.previewMore', { n: rows.length - shown.length })}
        </p>
      ) : null}
    </div>
  );
}

function ResultSummary({ results }: { results: readonly ImportResult[] }): ReactNode {
  const t = useT();
  const created = results.filter((r) => r.status === 'created').length;
  const failed = results.filter((r) => r.status === 'failed');
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{t('import.doneCreated', { n: created })}</p>
      {failed.length > 0 ? (
        <>
          <p className="text-sm font-medium text-[var(--danger-ink)]">
            {t('import.doneFailed', { n: failed.length })}
          </p>
          <ul className="max-h-60 overflow-auto text-xs text-muted">
            {failed.map((r) => (
              <li key={r.row.line}>
                {t('import.line', { line: r.row.line })} · {r.row.name}: {errorMessage(r.error, t)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function PickStep({ onLoaded }: { onLoaded: (loaded: Loaded) => void }): ReactNode {
  const t = useT();
  const { modules } = useShopModules();
  const inputRef = useRef<HTMLInputElement>(null);
  const load = async (file: File): Promise<void> => {
    if (modules === undefined) return;
    const parse = toImportRows(await file.text(), { modules });
    onLoaded({ fileName: file.name, parse });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{t('import.hint')}</p>
      <p className="text-sm text-muted">{t('import.columns')}</p>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void load(file);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={modules === undefined}
          onClick={() => inputRef.current?.click()}
        >
          <Upload size={16} aria-hidden="true" />
          {t('import.chooseFile')}
        </Button>
        <Button onClick={() => downloadFile('stock-template.csv', IMPORT_TEMPLATE_CSV, 'text/csv')}>
          <Download size={16} aria-hidden="true" />
          {t('import.template')}
        </Button>
      </div>
    </div>
  );
}

/** Import stock from CSV: pick a file, check the preview, import row by row, read the summary. */
export function StockImportDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const rows = loaded?.parse.rows ?? [];

  const reset = (): void => {
    setLoaded(null);
    setProgress(0);
    setResults(null);
  };
  const close = (): void => {
    reset();
    onClose();
  };

  const { busy, run: runImport } = useBusyAction(async (): Promise<void> => {
    setProgress(0);
    const done = await runStockImport(
      (input) => service.catalog.createAccessory(input),
      rows,
      setProgress,
    );
    if (done.some((r) => r.status === 'created')) bump();
    setResults(done);
  });

  const footer =
    results !== null ? (
      <Button variant="primary" onClick={close}>
        {t('common.close')}
      </Button>
    ) : loaded !== null ? (
      <>
        <Button onClick={reset} disabled={busy}>
          {t('import.back')}
        </Button>
        <Button
          variant="primary"
          disabled={rows.length === 0}
          loading={busy}
          onClick={() => void runImport()}
        >
          {busy
            ? t('import.progress', { done: progress, total: rows.length })
            : t('import.run', { n: rows.length })}
        </Button>
      </>
    ) : (
      <Button onClick={close}>{t('common.cancel')}</Button>
    );

  return (
    <Dialog
      open={open}
      onClose={close}
      width={900}
      dismissable={!busy}
      title={t('import.title')}
      footer={footer}
    >
      {results !== null ? (
        <ResultSummary results={results} />
      ) : loaded === null ? (
        <PickStep onLoaded={setLoaded} />
      ) : (
        <>
          <p className="mb-2 text-sm font-medium">
            {rows.length === 0
              ? t('import.noRows', { file: loaded.fileName })
              : t('import.ready', { n: rows.length })}
          </p>
          {rows.length > 0 ? <PreviewTable rows={rows} /> : null}
          <ProblemList problems={loaded.parse.problems} />
        </>
      )}
    </Dialog>
  );
}
