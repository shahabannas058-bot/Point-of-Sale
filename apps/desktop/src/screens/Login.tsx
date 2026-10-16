import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Languages, Lock, Store, WifiOff, ShieldCheck, Sparkles } from 'lucide-react';
import { isServiceError, type Role } from '@pos/shared';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';
import { Badge } from '../components/ui/Badge';
import { PinPad } from '../components/ui/PinPad';
import { ErrorBox } from '../components/ui/misc';
import { useT, type TKey } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { useRuntime } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { usePrefs } from '../store/prefs';
import { useSession } from '../store/session';

const LAST_USER_KEY = 'pos-last-user';

function readLastUser(): string | null {
  try {
    return localStorage.getItem(LAST_USER_KEY);
  } catch {
    return null;
  }
}

function BrandPanel({ shopName }: { shopName: string }): ReactNode {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const points: { icon: typeof WifiOff; key: TKey }[] = [
    { icon: WifiOff, key: 'login.pointOffline' },
    { icon: ShieldCheck, key: 'login.pointImmutable' },
    { icon: Languages, key: 'login.pointBilingual' },
  ];
  return (
    <aside className="brand-grid relative hidden flex-col justify-between overflow-hidden bg-[var(--rail)] p-10 text-white lg:flex">
      <div className="flex items-center gap-3">
        <div
          className="grid size-11 place-items-center rounded-xl bg-primary text-on-primary"
          aria-hidden="true"
        >
          <Store size={24} />
        </div>
        <span className="text-sm font-semibold text-slate-300">{t('app.name')}</span>
      </div>
      <div>
        <h1
          className={`display text-4xl font-bold leading-tight ${lang === 'ur' ? '' : 'tracking-tight'}`}
        >
          {shopName}
        </h1>
        <p className="mt-3 max-w-sm text-slate-300">{t('login.tagline')}</p>
        <ul className="mt-8 flex flex-col gap-3">
          {points.map((p) => (
            <li key={p.key} className="flex items-center gap-3 text-sm text-slate-200">
              <span
                className="grid size-8 place-items-center rounded-lg bg-white/10"
                aria-hidden="true"
              >
                <p.icon size={16} />
              </span>
              {t(p.key)}
            </li>
          ))}
        </ul>
      </div>
      <div className="font-mono text-xs text-slate-400 ltr" aria-hidden="true">
        Rs 1,23,45,678 · IMEI 35 693803 ······ · A-000042
      </div>
    </aside>
  );
}

function SetupWizard(): ReactNode {
  const t = useT();
  const rt = useRuntime();
  const bump = useDataVersion((s) => s.bump);
  const [form, setForm] = useState({
    shopName: '',
    branchName: 'Main Counter',
    invoicePrefix: 'A',
    username: 'owner',
    displayName: '',
    pin: '',
    pin2: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({
      ...f,
      [k]: k === 'invoicePrefix' ? e.target.value.toUpperCase() : e.target.value,
    }));

  const errs = {
    prefix: /^[A-Z0-9]{1,4}$/.test(form.invoicePrefix) ? null : t('setup.errPrefix'),
    username: /^[a-z0-9._-]{3,32}$/.test(form.username) ? null : t('setup.errUsername'),
    pin: /^\d{4,6}$/.test(form.pin) ? null : t('setup.errPin'),
    pin2: form.pin === form.pin2 ? null : t('setup.errPinMatch'),
  };
  const valid =
    form.shopName.trim() !== '' &&
    form.branchName.trim() !== '' &&
    form.displayName.trim() !== '' &&
    !errs.prefix &&
    !errs.username &&
    !errs.pin &&
    !errs.pin2;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await rt.service.setup.firstRun({
        shopName: form.shopName.trim(),
        branchName: form.branchName.trim(),
        invoicePrefix: form.invoicePrefix,
        owner: { username: form.username, displayName: form.displayName.trim(), pin: form.pin },
      });
      bump();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const demo = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await rt.loadDemo();
      window.location.reload();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex w-full max-w-lg flex-col gap-4"
      noValidate
    >
      <div>
        <h2 className="display text-2xl">{t('setup.title')}</h2>
        <p className="mt-1 text-sm text-muted">{t('setup.subtitle')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('setup.shopName')} className="sm:col-span-2">
          <Input
            value={form.shopName}
            onChange={set('shopName')}
            data-autofocus
            autoFocus
            required
          />
        </Field>
        <Field label={t('setup.branchName')}>
          <Input value={form.branchName} onChange={set('branchName')} required />
        </Field>
        <Field label={t('setup.prefix')} hint={t('setup.prefixHint')} error={errs.prefix}>
          <Input
            value={form.invoicePrefix}
            onChange={set('invoicePrefix')}
            maxLength={4}
            className="ltr"
            invalid={!!errs.prefix}
          />
        </Field>
        <Field label={t('setup.ownerName')}>
          <Input value={form.displayName} onChange={set('displayName')} required />
        </Field>
        <Field label={t('setup.username')} error={errs.username}>
          <Input
            value={form.username}
            onChange={set('username')}
            className="ltr"
            autoCapitalize="none"
            invalid={!!errs.username}
          />
        </Field>
        <Field label={t('setup.pin')} error={form.pin ? errs.pin : null} hint={t('setup.pinHint')}>
          <Input
            value={form.pin}
            onChange={set('pin')}
            type="password"
            inputMode="numeric"
            maxLength={6}
            className="ltr"
            autoComplete="new-password"
          />
        </Field>
        <Field label={t('setup.pinConfirm')} error={form.pin2 ? errs.pin2 : null}>
          <Input
            value={form.pin2}
            onChange={set('pin2')}
            type="password"
            inputMode="numeric"
            maxLength={6}
            className="ltr"
            autoComplete="new-password"
          />
        </Field>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" size="lg" disabled={!valid} loading={busy}>
          {t('setup.create')}
        </Button>
        <Button variant="secondary" onClick={() => void demo()} disabled={busy}>
          <Sparkles size={16} aria-hidden="true" />
          {t('setup.loadDemo')}
        </Button>
      </div>
    </form>
  );
}

function PinLogin(): ReactNode {
  const t = useT();
  const rt = useRuntime();
  const nav = useNavigate();
  const setSession = useSession((s) => s.set);
  const usersQ = useServiceQuery((s) => s.auth.listLoginUsers(), []);
  const shopQ = useServiceQuery((s) => s.setup.getShop(), []);
  const [picked, setPicked] = useState<string | null>(readLastUser);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [tick, setTick] = useState(Date.now());

  const users = usersQ.data ?? [];
  const selected = useMemo(
    () => users.find((u) => u.username === picked) ?? (users.length === 1 ? users[0] : undefined),
    [users, picked],
  );
  const remaining = Math.max(0, Math.ceil((lockedUntil - tick) / 1000));
  const locked = remaining > 0;

  useEffect(() => {
    if (!locked) return;
    const id = window.setInterval(() => setTick(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [locked]);

  const submit = async (value: string): Promise<void> => {
    if (!selected || busy || locked) return;
    setBusy(true);
    setError(null);
    try {
      const session = await rt.service.auth.login(selected.username, value);
      try {
        localStorage.setItem(LAST_USER_KEY, selected.username);
      } catch {
        /* private mode: remembering the last user is optional */
      }
      setSession(session);
      void nav('/', { replace: true });
    } catch (err) {
      setPin('');
      setError(err);
      if (isServiceError(err) && err.code === 'LOGIN_LOCKED') {
        const ms = typeof err.details.retryAfterMs === 'number' ? err.details.retryAfterMs : 30_000;
        setLockedUntil(Date.now() + ms);
        setTick(Date.now());
      }
    } finally {
      setBusy(false);
    }
  };

  const roleTone = (r: Role): 'primary' | 'success' | 'muted' =>
    r === 'owner' ? 'primary' : r === 'manager' ? 'success' : 'muted';

  return (
    <div className="flex w-full max-w-md flex-col gap-5">
      <div>
        <h2 className="display text-2xl">{t('login.title')}</h2>
        <p className="mt-1 text-sm text-muted">
          {selected ? t('login.enterPin', { name: selected.displayName }) : t('login.pickUser')}
        </p>
      </div>

      <div className="grid gap-2" role="radiogroup" aria-label={t('login.pickUser')}>
        {users.map((u) => {
          const on = selected?.username === u.username;
          return (
            <button
              key={u.username}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                setPicked(u.username);
                setPin('');
                setError(null);
              }}
              className={`flex min-h-14 items-center gap-3 rounded-xl border px-4 text-start transition-colors ${
                on ? 'border-primary bg-primary-soft' : 'border-line bg-surface hover:bg-surface-2'
              }`}
            >
              <span
                className="grid size-9 place-items-center rounded-full bg-surface-2 font-bold text-muted"
                aria-hidden="true"
              >
                {u.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="flex-1 font-semibold">{u.displayName}</span>
              <Badge tone={roleTone(u.role)}>{t(`role.${u.role}` as TKey)}</Badge>
            </button>
          );
        })}
      </div>

      {selected ? (
        <div className="flex flex-col gap-4">
          <PinPad
            value={pin}
            onChange={setPin}
            onSubmit={() => void submit(pin)}
            disabled={busy || locked}
          />
          <div
            aria-live="assertive"
            className="min-h-6 text-center text-sm font-medium text-[var(--danger-ink)]"
          >
            {locked
              ? t('err.LOGIN_LOCKED', { seconds: remaining })
              : error
                ? errorMessage(error, t)
                : null}
          </div>
          <Button
            variant="primary"
            size="lg"
            disabled={pin.length < 4 || locked}
            loading={busy}
            onClick={() => void submit(pin)}
          >
            <Lock size={18} aria-hidden="true" />
            {t('login.signIn')}
          </Button>
        </div>
      ) : null}

      {shopQ.data?.isDemo ? (
        <div className="rounded-xl border border-dashed border-line bg-surface-2 p-3 text-xs text-muted">
          <div className="mb-1 font-semibold text-ink">{t('login.demoHint')}</div>
          <div className="ltr grid grid-cols-3 gap-2 font-mono">
            <span>owner · 1234</span>
            <span>manager · 2345</span>
            <span>cashier · 3456</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Login(): ReactNode {
  const t = useT();
  const rt = useRuntime();
  const session = useSession((s) => s.session);
  const lang = usePrefs((s) => s.lang);
  const setLang = usePrefs((s) => s.setLang);
  const setupQ = useServiceQuery((s) => s.setup.isSetUp(), []);
  const settingsQ = useServiceQuery((s) => s.settings.get(), [], setupQ.data === true);

  if (session) return <Navigate to="/" replace />;
  const shopName = settingsQ.data?.shopName ?? t('app.name');

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <BrandPanel shopName={setupQ.data === false ? t('app.name') : shopName} />
      <main className="relative grid place-items-center p-6">
        <div className="absolute end-4 top-4">
          <Button
            variant="ghost"
            onClick={() => setLang(lang === 'en' ? 'ur' : 'en')}
            aria-label={t('shell.toggleLang')}
          >
            <Languages size={18} aria-hidden="true" />
            {lang === 'en' ? 'اردو' : 'English'}
          </Button>
        </div>
        {setupQ.loading && setupQ.data === undefined ? (
          <div className="skeleton h-64 w-full max-w-md" aria-hidden="true" />
        ) : setupQ.error ? (
          <ErrorBox error={setupQ.error} onRetry={setupQ.reload} />
        ) : setupQ.data ? (
          <PinLogin />
        ) : (
          <SetupWizard />
        )}
        <div className="absolute bottom-4 text-xs text-muted">
          {rt.mode === 'mock' ? t('login.mockMode') : null}
        </div>
      </main>
    </div>
  );
}
