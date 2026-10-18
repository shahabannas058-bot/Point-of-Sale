import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  items: ToastItem[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

/** How long a toast stays: errors longer, so they can be read. The toast's countdown line uses the same number. */
export const toastDuration = (kind: ToastKind): number => (kind === 'error' ? 7000 : 3500);

export const useToasts = create<ToastState>()((set, get) => ({
  items: [],
  push: (kind, message) => {
    seq += 1;
    const id = seq;
    set((s) => ({ items: [...s.items.slice(-3), { id, kind, message }] }));
    window.setTimeout(() => get().dismiss(id), toastDuration(kind));
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

export const toast = {
  success: (m: string): void => useToasts.getState().push('success', m),
  error: (m: string): void => useToasts.getState().push('error', m),
  warning: (m: string): void => useToasts.getState().push('warning', m),
  info: (m: string): void => useToasts.getState().push('info', m),
};
