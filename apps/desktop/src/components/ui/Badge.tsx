import type { ReactNode } from 'react';

export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'muted';

export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}): ReactNode {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
