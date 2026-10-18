import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { TriangleAlert, CircleCheck, Info, CircleX, X, type LucideIcon } from 'lucide-react';
import { useT } from '../../i18n';
import { toastDuration, useToasts, type ToastKind } from '../../store/toast';

const ICONS: Record<ToastKind, LucideIcon> = {
  success: CircleCheck,
  error: CircleX,
  warning: TriangleAlert,
  info: Info,
};

/**
 * Lives in the browser top layer (popover) so toasts stay visible above open modal dialogs.
 * It is re-promoted on every new toast so a toast raised while a dialog is open is on top.
 */
export function Toaster(): ReactNode {
  const t = useT();
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== 'function') return;
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      if (items.length > 0) el.showPopover();
    } catch {
      /* popover unsupported: toasts fall back to normal stacking */
    }
  }, [items]);

  return (
    <div
      ref={ref}
      popover="manual"
      className="toast-stack"
      style={{ background: 'transparent', border: 0, padding: 0, margin: 0, overflow: 'visible' }}
      role="region"
      aria-live="polite"
      aria-label={t('common.notifications')}
    >
      {items.map((it) => {
        const Icon = ICONS[it.kind];
        return (
          <div
            key={it.id}
            className="toast"
            data-kind={it.kind}
            role={it.kind === 'error' ? 'alert' : 'status'}
            style={{ '--toast-ms': `${toastDuration(it.kind)}ms` } as CSSProperties}
          >
            <span className="toast-icon" aria-hidden="true">
              <Icon size={18} />
            </span>
            <div className="toast-msg">{it.message}</div>
            <button
              type="button"
              className="toast-close"
              aria-label={t('common.close')}
              onClick={() => dismiss(it.id)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
