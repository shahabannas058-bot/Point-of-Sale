import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type { ModuleId } from '@pos/shared';
import { useT } from '../i18n';
import { useShopModules } from '../service/use-modules';
import { Empty } from './ui/misc';

/** Shows its children only when the shop owns the module; otherwise a plain "not in your plan" page. */
export function RequireModule({
  module,
  children,
}: {
  module: ModuleId;
  children: ReactNode;
}): ReactNode {
  const t = useT();
  const { modules, has } = useShopModules();
  if (modules === undefined) return <div className="skeleton h-40 w-full" aria-hidden="true" />;
  if (!has(module))
    return (
      <Empty
        icon={<Lock size={28} aria-hidden="true" />}
        title={t('module.disabled')}
        hint={t('module.disabledHint')}
      />
    );
  return children;
}
