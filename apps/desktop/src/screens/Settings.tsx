import { useEffect, useState, type ReactNode } from 'react';
import { Download, KeyRound, RotateCcw, ShieldCheck, UserPlus } from 'lucide-react';
import { ROLES, type ChainReport, type Role, type ShopSettings } from '@pos/shared';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input, Select } from '../components/ui/Field';
import { ErrorBox, PageHeader } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { useRuntime } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { usePrefs, type ReceiptLang, type ReceiptWidth, type ThemePref } from '../store/prefs';
import { useCan } from '../store/session';
import { toast } from '../store/toast';

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="card">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-base">{title}</h2>
        {hint ? <p className="mt-0.5 text-sm text-muted">{hint}</p> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string }[];
  label: string;
}): ReactNode {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          aria-pressed={value === i.value}
          onClick={() => onChange(i.value)}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

function ShopForm({ initial }: { initial: ShopSettings }): ReactNode {
  const t = useT();
  const rt = useRuntime();
  const bump = useDataVersion((s) => s.bump);
  const [f, setF] = useState({
    shopName: initial.shopName,
    address: initial.address ?? '',
    phone: initial.phone ?? '',
    footer: initial.receiptFooter ?? '',
    footerUr: initial.receiptFooterUr ?? '',
    maxDisc: String(initial.cashierMaxDiscountBps / 100),
    negative: initial.allowNegativeStock,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set =
    (k: 'shopName' | 'address' | 'phone' | 'footer' | 'footerUr' | 'maxDisc') =>
    (e: { target: { value: string } }) =>
      setF((s) => ({ ...s, [k]: e.target.value }));
  const pct = Number(f.maxDisc);
  const bad = !f.shopName.trim() || !Number.isFinite(pct) || pct < 0 || pct > 100;

  const save = async (): Promise<void> => {
    if (bad) return;
    setBusy(true);
    setError(null);
    try {
      await rt.service.settings.update({
        shopName: f.shopName.trim(),
        address: f.address.trim() || null,
        phone: f.phone.trim() || null,
        receiptFooter: f.footer.trim() || null,
        receiptFooterUr: f.footerUr.trim() || null,
        cashierMaxDiscountBps: Math.round(pct * 100),
        allowNegativeStock: f.negative,
      });
      bump();
      toast.success(t('common.saved'));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label={t('setup.shopName')}>
        <Input value={f.shopName} onChange={set('shopName')} />
      </Field>
      <Field label={t('customers.phone')}>
        <Input value={f.phone} onChange={set('phone')} className="ltr" />
      </Field>
      <Field label={t('customers.address')} className="sm:col-span-2">
        <Input value={f.address} onChange={set('address')} />
      </Field>
      <Field label={t('settings.footerEn')}>
        <Input value={f.footer} onChange={set('footer')} />
      </Field>
      <Field label={t('settings.footerUr')}>
        <Input value={f.footerUr} onChange={set('footerUr')} dir="rtl" lang="ur" />
      </Field>
      <Field label={t('settings.maxDiscount')} hint={t('settings.maxDiscountHint')}>
        <Input value={f.maxDisc} onChange={set('maxDisc')} inputMode="decimal" className="ltr" />
      </Field>
      <label className="check self-end">
        <input
          type="checkbox"
          checked={f.negative}
          onChange={(e) => setF((s) => ({ ...s, negative: e.target.checked }))}
        />
        {t('settings.allowNegative')}
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={bad} loading={busy}>
          {t('common.save')}
        </Button>
        <span role="alert" className="text-sm font-medium text-[var(--danger-ink)]">
          {error}
        </span>
      </div>
    </form>
  );
}

function IntegritySection(): ReactNode {
  const t = useT();
  const rt = useRuntime();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ChainReport | null>(null);
  const [checks, setChecks] = useState<{
    salePaymentMismatch: number;
    saleLineMismatch: number;
    badPhoneUnits: number;
    unsentOutbox: number;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const [r, c] = await Promise.all([
        rt.service.integrity.verifyChain(),
        rt.service.integrity.checks(),
      ]);
      setReport(r);
      setChecks(c);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Button className="self-start" loading={busy} onClick={() => void run()}>
        <ShieldCheck size={16} aria-hidden="true" />
        {t('settings.verifyChain')}
      </Button>
      {error ? <ErrorBox error={error} /> : null}
      {report ? (
        report.ok ? (
          <div
            role="status"
            className="rounded-xl border border-success bg-success-soft p-3 text-sm font-medium text-[var(--success-ink)]"
          >
            {t('settings.chainOk', { n: report.count })}
            <span className="ltr mt-1 block font-mono text-xs opacity-80">
              {report.headHash.slice(0, 24)}…
            </span>
          </div>
        ) : (
          <div
            role="alert"
            className="rounded-xl border border-danger bg-danger-soft p-3 text-sm font-medium text-[var(--danger-ink)]"
          >
            {t('settings.chainBroken', { no: report.invoiceNo ?? '?', reason: report.reason })}
          </div>
        )
      ) : null}
      {checks ? (
        <dl className="ltr grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
          {Object.entries(checks).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd
                className={`num font-semibold ${v > 0 && k !== 'unsentOutbox' ? 'text-[var(--danger-ink)]' : ''}`}
              >
                {v}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function UsersSection(): ReactNode {
  const t = useT();
  const rt = useRuntime();
  const bump = useDataVersion((s) => s.bump);
  const users = useServiceQuery((s) => s.auth.listUsers(), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ username: '', displayName: '', role: 'cashier' as Role, pin: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid =
    /^[a-z0-9._-]{3,32}$/.test(f.username) &&
    f.displayName.trim() !== '' &&
    /^\d{4,6}$/.test(f.pin);

  const create = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await rt.service.auth.createUser({ ...f, displayName: f.displayName.trim() });
      bump();
      setOpen(false);
      toast.success(t('common.saved'));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {users.error ? <ErrorBox error={users.error} onRetry={users.reload} /> : null}
      <ul className="divide-y divide-line rounded-xl border border-line">
        {(users.data ?? []).map((u) => (
          <li key={u.id} className="flex min-h-12 items-center gap-3 px-4 py-2">
            <span className="flex-1">
              <span className="font-semibold">{u.displayName}</span>{' '}
              <span className="ltr text-sm text-muted">@{u.username}</span>
            </span>
            <Badge
              tone={u.role === 'owner' ? 'primary' : u.role === 'manager' ? 'success' : 'muted'}
            >
              {t(dynKey('role', u.role))}
            </Badge>
            {!u.isActive ? <Badge tone="danger">{t('settings.inactive')}</Badge> : null}
          </li>
        ))}
      </ul>
      <Button
        className="self-start"
        onClick={() => {
          setF({ username: '', displayName: '', role: 'cashier', pin: '' });
          setError(null);
          setOpen(true);
        }}
      >
        <UserPlus size={16} aria-hidden="true" />
        {t('settings.addUser')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        width={440}
        title={t('settings.addUser')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!valid}
              loading={busy}
              onClick={() => void create()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Field label={t('setup.ownerName')}>
            <Input
              value={f.displayName}
              onChange={(e) => setF((s) => ({ ...s, displayName: e.target.value }))}
              data-autofocus
            />
          </Field>
          <Field
            label={t('setup.username')}
            error={
              f.username && !/^[a-z0-9._-]{3,32}$/.test(f.username) ? t('setup.errUsername') : null
            }
          >
            <Input
              value={f.username}
              onChange={(e) => setF((s) => ({ ...s, username: e.target.value }))}
              className="ltr"
              autoCapitalize="none"
            />
          </Field>
          <Field label={t('settings.role')}>
            <Select
              value={f.role}
              onChange={(e) => setF((s) => ({ ...s, role: e.target.value as Role }))}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(dynKey('role', r))}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('setup.pin')} hint={t('setup.pinHint')}>
            <Input
              value={f.pin}
              onChange={(e) =>
                setF((s) => ({ ...s, pin: e.target.value.replace(/\D/g, '').slice(0, 6) }))
              }
              type="password"
              inputMode="numeric"
              className="ltr"
              autoComplete="new-password"
            />
          </Field>
          <div role="alert" className="min-h-5 text-sm font-medium text-[var(--danger-ink)]">
            {error}
          </div>
          <button type="submit" className="sr-only" tabIndex={-1}>
            {t('common.save')}
          </button>
        </form>
      </Dialog>
    </div>
  );
}

function ChangePin(): ReactNode {
  const t = useT();
  const rt = useRuntime();
  const [open, setOpen] = useState(false);
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setOldPin('');
      setNewPin('');
      setError(null);
    }
  }, [open]);
  const valid = /^\d{4,6}$/.test(oldPin) && /^\d{4,6}$/.test(newPin);
  const save = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await rt.service.auth.changePin(oldPin, newPin);
      toast.success(t('common.saved'));
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button className="self-start" onClick={() => setOpen(true)}>
        <KeyRound size={16} aria-hidden="true" />
        {t('settings.changePin')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        width={400}
        title={t('settings.changePin')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={!valid} loading={busy} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={t('settings.oldPin')}>
            <Input
              value={oldPin}
              onChange={(e) => setOldPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              type="password"
              inputMode="numeric"
              className="ltr"
              data-autofocus
              autoComplete="current-password"
            />
          </Field>
          <Field label={t('settings.newPin')} hint={t('setup.pinHint')}>
            <Input
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              type="password"
              inputMode="numeric"
              className="ltr"
              autoComplete="new-password"
            />
          </Field>
          <div role="alert" className="min-h-5 text-sm font-medium text-[var(--danger-ink)]">
            {error}
          </div>
          <button type="submit" className="sr-only" tabIndex={-1}>
            {t('common.save')}
          </button>
        </form>
      </Dialog>
    </>
  );
}

export function Settings(): ReactNode {
  const t = useT();
  const rt = useRuntime();
  const can = useCan();
  const prefs = usePrefs();
  const settings = useServiceQuery((s) => s.settings.get(), []);
  const shop = useServiceQuery((s) => s.setup.getShop(), []);
  const [resetOpen, setResetOpen] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);

  const exportDb = (): void => {
    const bytes = rt.exportBytes?.();
    if (!bytes) return;
    const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pos-backup-${new Date().toISOString().slice(0, 10)}.sqlite`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = async (): Promise<void> => {
    setBusy(true);
    try {
      await rt.resetDemo();
      window.location.hash = '#/login';
      window.location.reload();
    } catch (e) {
      toast.error(errorMessage(e, t));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader title={t('nav.settings')} />

      <Section title={t('settings.appearance')}>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <Field label={t('settings.language')}>
            <Segmented
              label={t('settings.language')}
              value={prefs.lang}
              onChange={prefs.setLang}
              items={[
                { value: 'en', label: 'English' },
                { value: 'ur', label: 'اردو' },
              ]}
            />
          </Field>
          <Field label={t('settings.theme')}>
            <Segmented<ThemePref>
              label={t('settings.theme')}
              value={prefs.theme}
              onChange={prefs.setTheme}
              items={[
                { value: 'light', label: t('settings.themeLight') },
                { value: 'dark', label: t('settings.themeDark') },
                { value: 'system', label: t('settings.themeSystem') },
              ]}
            />
          </Field>
          <Field label={t('settings.receiptWidth')}>
            <Segmented<ReceiptWidth>
              label={t('settings.receiptWidth')}
              value={prefs.receiptWidth}
              onChange={prefs.setReceiptWidth}
              items={[
                { value: '58', label: '58 mm' },
                { value: '80', label: '80 mm' },
              ]}
            />
          </Field>
          <Field label={t('settings.receiptLang')}>
            <Segmented<ReceiptLang>
              label={t('settings.receiptLang')}
              value={prefs.receiptLang}
              onChange={prefs.setReceiptLang}
              items={[
                { value: 'en', label: 'English' },
                { value: 'ur', label: 'اردو' },
                { value: 'both', label: 'EN + اردو' },
              ]}
            />
          </Field>
        </div>
      </Section>

      {can('manage_settings') ? (
        <Section title={t('settings.shop')}>
          {settings.error ? (
            <ErrorBox error={settings.error} onRetry={settings.reload} />
          ) : settings.data ? (
            <ShopForm key={JSON.stringify(settings.data)} initial={settings.data} />
          ) : null}
        </Section>
      ) : null}

      <Section title={t('settings.account')}>
        <ChangePin />
      </Section>

      {can('manage_users') ? (
        <Section title={t('settings.users')}>
          <UsersSection />
        </Section>
      ) : null}

      <Section title={t('settings.integrity')} hint={t('settings.integrityHint')}>
        <IntegritySection />
      </Section>

      <Section title={t('settings.backup')}>
        <div className="flex flex-col gap-2">
          <Button className="self-start" disabled={!rt.exportBytes} onClick={exportDb}>
            <Download size={16} aria-hidden="true" />
            {t('settings.exportDb')}
          </Button>
          <p className="text-sm text-muted">
            {rt.exportBytes ? t('settings.cloudBackup') : t('settings.exportUnavailable')}
          </p>
        </div>
      </Section>

      {shop.data?.isDemo && can('manage_settings') ? (
        <Section title={t('settings.demo')} hint={t('settings.demoHint')}>
          <Button
            variant="danger-outline"
            onClick={() => {
              setWord('');
              setResetOpen(true);
            }}
          >
            <RotateCcw size={16} aria-hidden="true" />
            {t('settings.resetDemo')}
          </Button>
          <Dialog
            open={resetOpen}
            onClose={() => setResetOpen(false)}
            width={440}
            dismissable={!busy}
            title={t('settings.resetDemo')}
            footer={
              <>
                <Button onClick={() => setResetOpen(false)} disabled={busy}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="danger"
                  disabled={word.trim().toUpperCase() !== 'RESET'}
                  loading={busy}
                  onClick={() => void reset()}
                >
                  {t('settings.resetDemo')}
                </Button>
              </>
            }
          >
            <p className="mb-3 text-sm">{t('settings.resetConfirm')}</p>
            <Input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              className="ltr"
              placeholder="RESET"
              aria-label="RESET"
              data-autofocus
            />
          </Dialog>
        </Section>
      ) : null}
    </div>
  );
}
