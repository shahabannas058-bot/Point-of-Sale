import type { ReactNode } from 'react';
import type { RepairStatus } from '@pos/shared';
import { useT, type TKey } from '../../i18n';
import { Badge, type Tone } from '../ui/Badge';

/** The happy path shown in the stepper; 'cancelled' is a side exit. */
export const REPAIR_FLOW: readonly RepairStatus[] = [
  'received',
  'diagnosing',
  'in_repair',
  'ready',
  'delivered',
];

const TONE: Record<RepairStatus, Tone> = {
  received: 'muted',
  diagnosing: 'warning',
  in_repair: 'primary',
  ready: 'success',
  delivered: 'muted',
  cancelled: 'danger',
};

export const statusKey = (s: RepairStatus): TKey => `repair.status.${s}`;

export const isClosed = (s: RepairStatus): boolean => s === 'delivered' || s === 'cancelled';

export function RepairStatusBadge({ status }: { status: RepairStatus }): ReactNode {
  const t = useT();
  return <Badge tone={TONE[status]}>{t(statusKey(status))}</Badge>;
}
