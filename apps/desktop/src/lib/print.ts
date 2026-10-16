import { create } from 'zustand';
import type { ReceiptModel } from './receipt-model';

interface PrintState {
  job: ReceiptModel | null;
  set: (job: ReceiptModel | null) => void;
}

export const usePrintJob = create<PrintState>()((set) => ({
  job: null,
  set: (job) => set({ job }),
}));

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

/** Renders the receipt into #print-root, then opens the print dialog with only that visible. */
export async function printReceipt(model: ReceiptModel): Promise<void> {
  usePrintJob.getState().set(model);
  await nextFrame();
  await nextFrame();
  document.body.dataset.print = 'receipt';
  const done = (): void => {
    delete document.body.dataset.print;
    usePrintJob.getState().set(null);
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

/** Prints the current screen (reports, statements) using the @media print rules. */
export function printPage(): void {
  window.print();
}
