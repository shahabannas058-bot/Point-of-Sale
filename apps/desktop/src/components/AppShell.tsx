import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import {
  Boxes,
  CalendarClock,
  ChartColumn,
  LayoutDashboard,
  LogOut,
  Moon,
  Receipt,
  Settings as SettingsIcon,
  ShieldCheck,
  ShoppingCart,
  Sun,
  Truck,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { hasModule, type ModuleId, type Permission } from '@pos/shared';
import { useT, type TKey } from '../i18n';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { usePrefs } from '../store/prefs';
import { useSession, useCan } from '../store/session';
import { BrandMark } from './BrandMark';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { LanguageSwitch } from './LanguageSwitch';
import { MorphPill } from './ui/MorphPill';

interface NavItem {
  to: string;
  key: TKey;
  icon: LucideIcon;
  perm: Permission | null;
  /** Shown only when the shop owns this module (hidden until the shop is known). */
  module?: ModuleId;
}

const NAV: NavItem[] = [
  { to: '/dashboard', key: 'nav.dashboard', icon: LayoutDashboard, perm: 'view_reports' },
  { to: '/', key: 'nav.billing', icon: ShoppingCart, perm: 'sell' },
  { to: '/inventory', key: 'nav.inventory', icon: Boxes, perm: 'view_catalog' },
  {
    to: '/expiry',
    key: 'nav.expiry',
    icon: CalendarClock,
    perm: 'view_catalog',
    module: 'batch_expiry',
  },
  { to: '/sales', key: 'nav.sales', icon: Receipt, perm: 'sell' },
  { to: '/cash', key: 'nav.cash', icon: Wallet, perm: 'sell' },
  { to: '/repairs', key: 'nav.repairs', icon: Wrench, perm: 'sell', module: 'repair' },
  { to: '/warranty', key: 'nav.warranty', icon: ShieldCheck, perm: 'sell', module: 'warranty' },
  { to: '/customers', key: 'nav.customers', icon: Users, perm: 'receive_khata' },
  { to: '/suppliers', key: 'nav.suppliers', icon: Truck, perm: 'receive_stock' },
  { to: '/reports', key: 'nav.reports', icon: ChartColumn, perm: 'view_reports' },
  { to: '/settings', key: 'nav.settings', icon: SettingsIcon, perm: null },
];

export function RequireSession({ children }: { children: ReactNode }): ReactNode {
  const session = useSession((s) => s.session);
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

function useEffectiveDark(): boolean {
  const theme = usePrefs((s) => s.theme);
  const [sysDark, setSysDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = (e: MediaQueryListEvent): void => setSysDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return theme === 'dark' || (theme === 'system' && sysDark);
}

export function AppShell(): ReactNode {
  const t = useT();
  const nav = useNavigate();
  const service = useService();
  const can = useCan();
  const session = useSession((s) => s.session);
  const setSession = useSession((s) => s.set);
  const setTheme = usePrefs((s) => s.setTheme);
  const dark = useEffectiveDark();
  const shopQ = useServiceQuery((s) => s.setup.getShop(), []);
  const settingsQ = useServiceQuery((s) => s.settings.get(), []);
  const { pathname } = useLocation();
  const railRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // in a small window the menu is a bar that scrolls sideways: keep the current page's item in view
    railRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [pathname]);

  const logout = (): void => {
    service.auth.logout();
    setSession(null);
    void nav('/login', { replace: true });
  };

  return (
    <div className="shell">
      <nav className="rail no-print" aria-label={t('nav.main')}>
        <div className="mb-4 flex items-center gap-3 px-1.5 pt-1">
          <BrandMark size={40} />
          <div className="rail-label min-w-0 leading-tight">
            <div className="truncate text-[0.95rem] font-bold text-white">
              {settingsQ.data?.shopName ?? t('app.name')}
            </div>
            <div className="truncate text-xs text-[var(--rail-text)]">
              {shopQ.data?.branchName ?? ''}
            </div>
          </div>
        </div>
        <div ref={railRef} className="rail-nav">
          <MorphPill containerRef={railRef} selector="[aria-current='page']" watch={pathname} />
          {NAV.filter(
            (n) =>
              (n.perm === null || can(n.perm)) &&
              (n.module === undefined ||
                (shopQ.data !== undefined && hasModule(shopQ.data.modules, n.module))),
          ).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className="rail-link" title={t(n.key)}>
              <n.icon size={20} aria-hidden="true" className="shrink-0" />
              <span className="rail-label">{t(n.key)}</span>
            </NavLink>
          ))}
        </div>
        <div className="mt-auto flex flex-col gap-1">
          <div className="rail-label px-3 pb-1 text-[0.7rem] text-[var(--rail-text)] opacity-70">
            {t('app.name')}
          </div>
        </div>
      </nav>

      <div className="min-w-0">
        <header className="topbar no-print">
          {/* in a small window the demo banner gets a row of its own, on one line, instead of being squeezed */}
          <div className={`min-w-0 flex-1 ${shopQ.data?.isDemo ? 'max-[640px]:basis-full' : ''}`}>
            {shopQ.data?.isDemo ? (
              <span className="block w-fit max-w-full truncate rounded-full bg-warning-soft px-3 py-1 text-xs font-semibold text-[var(--warning-ink)]">
                {t('shell.demoBanner')}
              </span>
            ) : null}
          </div>
          <Button
            variant="ghost"
            icon
            aria-label={t('shell.toggleTheme')}
            onClick={() => setTheme(dark ? 'light' : 'dark')}
          >
            {dark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
          </Button>
          <LanguageSwitch />
          <div className="ms-2 flex items-center gap-2 border-s border-line ps-3 max-[520px]:ms-0 max-[520px]:border-s-0 max-[520px]:ps-0">
            <div className="text-end leading-tight max-[520px]:hidden">
              <div className="text-sm font-semibold">{session?.user.displayName}</div>
              <div className="mt-0.5">
                <Badge tone="primary">{t(`role.${session?.user.role ?? 'cashier'}` as TKey)}</Badge>
              </div>
            </div>
            <Button variant="ghost" icon aria-label={t('shell.logout')} onClick={logout}>
              <LogOut size={18} aria-hidden="true" className="rtl:-scale-x-100" />
            </Button>
          </div>
        </header>
        <main className="page">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
