import type { ReactNode } from 'react';
import type { PhoneUnitView } from '@pos/shared';
import { useT } from '../i18n';
import { ConditionBadge, PtaBadge } from './ProductBadges';
import { Dialog } from './ui/Dialog';
import { Money } from './ui/misc';

/** Several in-stock units of one model: pick the exact IMEI being sold. */
export function ImeiPicker({
  units,
  onPick,
  onClose,
}: {
  units: PhoneUnitView[] | null;
  onPick: (u: PhoneUnitView) => void;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const title = units?.[0]?.label ?? '';
  return (
    <Dialog
      open={units !== null}
      onClose={onClose}
      width={620}
      title={`${t('billing.pickUnit')} · ${title}`}
    >
      <ul className="flex flex-col gap-2">
        {(units ?? []).map((u, i) => (
          <li key={u.unit.id}>
            <button
              type="button"
              data-autofocus={i === 0 ? true : undefined}
              onClick={() => onPick(u)}
              className="flex min-h-14 w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-surface px-4 py-2 text-start hover:border-primary hover:bg-primary-soft"
            >
              <span className="ltr font-mono text-sm font-semibold">
                {u.unit.imei1 ?? u.unit.serial}
              </span>
              <span className="text-sm text-muted">{u.unit.colour ?? ''}</span>
              <span className="flex flex-1 flex-wrap gap-1.5">
                <PtaBadge status={u.unit.ptaStatus} />
                <ConditionBadge condition={u.unit.condition} />
              </span>
              <Money value={u.unit.salePrice} className="font-semibold" />
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
