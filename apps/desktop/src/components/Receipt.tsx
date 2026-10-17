import { Fragment, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dynKey, translate, type TKey } from '../i18n';
import { formatDateTime } from '../lib/dates';
import { formatRs } from '../lib/money';
import { usePrintJob } from '../lib/print';
import type { ReceiptModel } from '../lib/receipt-model';
import { usePrefs, type ReceiptLang, type ReceiptWidth } from '../store/prefs';

/** Label in the receipt language(s): "Raseed", "Receipt" or "Receipt / Raseed" (Roman Urdu). In "both", a
    word that is the same in both languages (Total, Cash) is printed once. */
function label(lang: ReceiptLang, key: TKey): ReactNode {
  const en = translate('en', key);
  const ur = translate('ur', key);
  if (lang === 'en') return en;
  if (lang === 'ur' || en === ur) return lang === 'ur' ? ur : en;
  return `${en} / ${ur}`;
}

const money = (p: number): string => formatRs(p, { symbol: null, decimals: 'auto' });

export function Receipt({
  model,
  width,
  lang,
}: {
  model: ReceiptModel;
  width: ReceiptWidth;
  lang: ReceiptLang;
}): ReactNode {
  const titleKey: TKey =
    model.kind === 'sale'
      ? 'receipt.invoice'
      : model.kind === 'return'
        ? 'receipt.return'
        : 'receipt.void';
  const footer =
    lang === 'ur' ? (model.footerUr ?? model.footer) : (model.footer ?? model.footerUr);
  return (
    <div className="receipt" data-width={width} data-testid="receipt">
      <div className="r-center r-b" style={{ fontSize: '1.25em' }}>
        {model.shopName}
      </div>
      {model.address ? <div className="r-center">{model.address}</div> : null}
      {model.phone ? <div className="r-center">{model.phone}</div> : null}
      <hr />
      <div className="r-center r-b">{label(lang, titleKey)}</div>
      <div className="r-row">
        <span>{label(lang, 'receipt.no')}</span>
        <span className="r-b">{model.invoiceNo}</span>
      </div>
      {model.originalInvoiceNo ? (
        <div className="r-row">
          <span>{label(lang, 'receipt.original')}</span>
          <span>{model.originalInvoiceNo}</span>
        </div>
      ) : null}
      <div className="r-row">
        <span>{label(lang, 'receipt.date')}</span>
        <span>{formatDateTime(model.createdAt)}</span>
      </div>
      <div className="r-row">
        <span>{label(lang, 'receipt.cashier')}</span>
        <span>{model.cashier}</span>
      </div>
      {model.customer ? (
        <div className="r-row">
          <span>{label(lang, 'receipt.customer')}</span>
          <span>{model.customer}</span>
        </div>
      ) : null}
      <hr />
      {model.items.map((it, i) => (
        <Fragment key={i}>
          <div className="r-b">{it.name}</div>
          {it.sub ? <div>IMEI/SN: {it.sub}</div> : null}
          <div className="r-row">
            <span>
              {it.qty} × {money(it.unitPrice)}
              {it.discount > 0 ? ` (-${money(it.discount)})` : ''}
            </span>
            <span className="r-b">{money(it.total)}</span>
          </div>
        </Fragment>
      ))}
      <hr />
      <div className="r-row">
        <span>{label(lang, 'receipt.subtotal')}</span>
        <span>{money(model.subtotal)}</span>
      </div>
      {model.discountTotal > 0 ? (
        <div className="r-row">
          <span>{label(lang, 'receipt.discount')}</span>
          <span>-{money(model.discountTotal)}</span>
        </div>
      ) : null}
      <div className="r-row r-total">
        <span>{label(lang, model.kind === 'sale' ? 'receipt.total' : 'receipt.refund')}</span>
        <span>Rs {money(model.total)}</span>
      </div>
      <hr />
      {model.payments.map((p, i) => (
        <div className="r-row" key={i}>
          <span>{label(lang, dynKey('method', p.method))}</span>
          <span>{money(p.amount)}</span>
        </div>
      ))}
      <hr />
      <div className="r-center">
        {footer ?? translate(lang === 'ur' ? 'ur' : 'en', 'receipt.thanks')}
      </div>
      {lang === 'both' && !footer ? (
        <div className="r-center">{translate('ur', 'receipt.thanks')}</div>
      ) : null}
    </div>
  );
}

/** On-screen preview with the same markup as the printed slip. */
export function ReceiptPreview({ model }: { model: ReceiptModel }): ReactNode {
  const width = usePrefs((s) => s.receiptWidth);
  const lang = usePrefs((s) => s.receiptLang);
  return (
    <div className="receipt-preview">
      <Receipt model={model} width={width} lang={lang} />
    </div>
  );
}

/** Mounted once in App: portals the current print job into #print-root. */
export function PrintRoot(): ReactNode {
  const job = usePrintJob((s) => s.job);
  const width = usePrefs((s) => s.receiptWidth);
  const lang = usePrefs((s) => s.receiptLang);
  const host = document.getElementById('print-root');
  if (!job || !host) return null;
  return createPortal(<Receipt model={job} width={width} lang={lang} />, host);
}
