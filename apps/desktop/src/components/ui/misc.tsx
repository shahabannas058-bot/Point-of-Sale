import { useRef, type ReactNode } from 'react';
import { CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n';
import { errorMessage } from '../../i18n/errors';
import { formatRs, type FormatRsOptions } from '../../lib/money';
import { Button } from './Button';
import { MorphPill } from './MorphPill';

export function Money({
  value,
  className = '',
  ...opts
}: { value: number; className?: string } & FormatRsOptions): ReactNode {
  return <span className={`num ltr ${className}`}>{formatRs(value, opts)}</span>;
}

export function Empty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center text-muted">
      <div className="mb-1 rounded-full bg-surface-2 p-3">
        {icon ?? <Inbox size={26} aria-hidden="true" />}
      </div>
      <div className="text-base font-semibold text-ink">{title}</div>
      {hint ? <div className="max-w-sm text-sm">{hint}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }): ReactNode {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-danger bg-danger-soft p-4 text-[var(--danger-ink)]"
    >
      <CircleAlert size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="flex-1 text-sm font-medium">{errorMessage(error, t)}</div>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />
          {t('common.retry')}
        </Button>
      ) : null}
    </div>
  );
}

export function SkeletonRows({ rows = 6 }: { rows?: number }): ReactNode {
  return (
    <div className="flex flex-col gap-2 p-3" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-9" style={{ opacity: 1 - i * 0.1 }} />
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <span className="kbd">{children}</span>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="display text-2xl">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
  label: string;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="seg" role="tablist" aria-label={label}>
      <MorphPill containerRef={ref} selector="[aria-selected='true']" watch={value} />
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
