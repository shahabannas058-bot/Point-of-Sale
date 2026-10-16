import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useT } from '../../i18n';
import { Button } from './Button';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** when false, Esc and backdrop clicks do nothing (use while a request is running) */
  dismissable?: boolean;
}

/** Native <dialog>: focus trap, inert background and Esc come from the platform. Content mounts only while open. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width,
  dismissable = true,
}: DialogProps): ReactNode {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      const target =
        el.querySelector<HTMLElement>('[data-autofocus]') ??
        el.querySelector<HTMLElement>(
          '.dlg-body input:not([disabled]), .dlg-body select, .dlg-body textarea',
        );
      target?.focus();
      if (target instanceof HTMLInputElement) target.select();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dlg"
      style={width ? ({ '--dlg-w': `${width}px` } as CSSProperties) : undefined}
      aria-label={typeof title === 'string' ? title : undefined}
      onCancel={(e) => {
        if (!dismissable) e.preventDefault();
      }}
      onClose={() => onCloseRef.current()}
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      {open ? (
        <>
          <div className="dlg-head">
            <h2 className="text-lg">{title}</h2>
            <Button
              variant="ghost"
              icon
              size="sm"
              aria-label={t('common.close')}
              onClick={onClose}
              disabled={!dismissable}
            >
              <X size={18} aria-hidden="true" />
            </Button>
          </div>
          <div className="dlg-body">{children}</div>
          {footer ? <div className="dlg-foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}
