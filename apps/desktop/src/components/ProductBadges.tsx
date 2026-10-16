import type { ReactNode } from 'react';
import type { PhoneCondition, PtaStatus } from '@pos/shared';
import { dynKey, useT } from '../i18n';
import { Badge } from './ui/Badge';

export function PtaBadge({ status }: { status: PtaStatus }): ReactNode {
  const t = useT();
  const tone = status === 'approved' ? 'success' : status === 'jv' ? 'warning' : 'danger';
  return <Badge tone={tone}>{t(dynKey('pta', status))}</Badge>;
}

export function ConditionBadge({ condition }: { condition: PhoneCondition }): ReactNode {
  const t = useT();
  const tone = condition === 'new' ? 'primary' : condition === 'open_box' ? 'warning' : 'muted';
  return <Badge tone={tone}>{t(dynKey('condition', condition))}</Badge>;
}
