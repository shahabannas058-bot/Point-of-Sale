import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ScanLine, ShieldAlert, ShieldCheck, ShieldOff, ShieldPlus } from 'lucide-react';
import {
  WARRANTY_KINDS,
  isServiceError,
  type WarrantyKind,
  type WarrantyLookup,
  type WarrantyState,
} from '@pos/shared';
import { Badge, type Tone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input } from '../components/ui/Field';
import { Empty, ErrorBox, PageHeader, SkeletonRows, Tabs } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { formatDate } from '../lib/dates';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { toast } from '../store/toast';

const STATE_TONE: Record<WarrantyState, Tone> = {
  active: 'success',
  expired: 'danger',
  void: 'warning',
};
const DAY_PRESETS = [30, 90, 180, 365] as const;
type Window = '7' | '30' | '90';

/** What the counter should see first: any active warranty wins, then expired, then void. */
function bestState(l: WarrantyLookup): WarrantyState | null {
  const states = l.warranties.map((w) => w.state);
  return (['active', 'expired', 'void'] as const).find((s) => states.includes(s)) ?? null;
}

function RegisterDialog({
  open,
  lookup,
  onClose,
}: {
  open: boolean;
  lookup: WarrantyLookup;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [kind, setKind] = useState<WarrantyKind>('shop');
  const [days, setDays] = useState('90');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setKind('shop');
      setDays('90');
      setNote('');
      setErr(null);
    }
  }, [open]);
  const n = Number.parseInt(days, 10);
  const daysOk = Number.isInteger(n) && n > 0 && n <= 3650;

  const save = async (): Promise<void> => {
    if (!lookup.sale || !daysOk || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await service.warranty.register({
        saleId: lookup.sale.saleId,
        phoneUnitId: lookup.unit.unit.id,
        kind,
        days: n,
        note: note.trim() || null,
      });
      bump();
      toast.success(t('warranty.registered'));
      onClose();
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={480}
      dismissable={!busy}
      title={t('warranty.register')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!daysOk} loading={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="field">
          <span className="label">{t('warranty.kind')}</span>
          <Tabs<WarrantyKind>
            label={t('warranty.kind')}
            value={kind}
            onChange={setKind}
            items={WARRANTY_KINDS.map((k) => ({ value: k, label: t(dynKey('warranty.kind', k)) }))}
          />
        </div>
        <div className="field" role="group" aria-label={t('warranty.days')}>
          <span className="label">{t('warranty.days')}</span>
          <div className="flex flex-wrap gap-2">
            {DAY_PRESETS.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={String(d) === days ? 'primary' : 'secondary'}
                onClick={() => setDays(String(d))}
              >
                {t('warranty.nDays', { n: d })}
              </Button>
            ))}
            <Input
              value={days}
              onChange={(e) => setDays(e.target.value)}
              inputMode="numeric"
              className="ltr num input-sm w-24"
              invalid={!daysOk}
              aria-label={t('warranty.days')}
            />
          </div>
          <span className="hint">{t('warranty.daysHint')}</span>
        </div>
        <Field label={t('warranty.note')}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {err ? (
          <div role="alert" className="text-sm font-medium text-[var(--danger-ink)]">
            {err}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function LookupResult({ lookup }: { lookup: WarrantyLookup }): ReactNode {
  const t = useT();
  const [registering, setRegistering] = useState(false);
  const state = bestState(lookup);
  const u = lookup.unit.unit;
  const tone: Tone = state ? STATE_TONE[state] : 'muted';
  const Icon = state === 'active' ? ShieldCheck : state === 'expired' ? ShieldAlert : ShieldOff;
  const canRegister = lookup.sale !== null && !lookup.sale.returned;
  const heroStyle = {
    '--tone': tone === 'muted' ? 'var(--surface-2)' : `var(--${tone}-soft)`,
  } as CSSProperties;

  return (
    <div className="glass-hero" style={heroStyle}>
      <div className="flex flex-wrap items-start gap-4">
        <span
          className="grid size-16 shrink-0 place-items-center rounded-3xl"
          style={{
            background: tone === 'muted' ? 'var(--surface-2)' : `var(--${tone}-soft)`,
            color: tone === 'muted' ? 'var(--text-muted)' : `var(--${tone}-ink)`,
          }}
          aria-hidden="true"
        >
          <Icon size={32} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="display text-xl font-bold">
            {state ? t(dynKey('warranty.state', state)) : t('warranty.none')}
          </div>
          <div className="mt-0.5 font-semibold">{lookup.unit.label}</div>
          <div className="ltr num text-sm text-muted">
            {[u.imei1, u.imei2, u.serial].filter(Boolean).join(' · ')}
          </div>
        </div>
        {canRegister ? (
          <Button variant="primary" onClick={() => setRegistering(true)}>
            <ShieldPlus size={16} aria-hidden="true" />
            {t('warranty.register')}
          </Button>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {lookup.sale ? (
          <>
            <div>
              <div className="text-xs font-semibold text-muted">{t('warranty.invoice')}</div>
              <div className="ltr font-semibold">{lookup.sale.invoiceNo}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-muted">{t('warranty.soldOn')}</div>
              <div className="ltr">{formatDate(lookup.sale.soldAt)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-muted">{t('billing.customer')}</div>
              <div>
                {lookup.sale.customerId ? (
                  <Link
                    to={`/customers/${lookup.sale.customerId}`}
                    className="font-semibold text-[var(--primary-ink)]"
                  >
                    {lookup.sale.customerName}
                  </Link>
                ) : (
                  (lookup.sale.customerName ?? t('warranty.walkIn'))
                )}
              </div>
            </div>
            {lookup.sale.returned ? (
              <div className="sm:col-span-3">
                <Badge tone="warning">{t('warranty.returned')}</Badge>
              </div>
            ) : null}
          </>
        ) : (
          <div className="text-sm text-muted sm:col-span-3">{t('warranty.neverSold')}</div>
        )}
      </div>

      {lookup.warranties.length > 0 ? (
        <ul className="m-0 mt-4 flex list-none flex-col gap-2 p-0">
          {lookup.warranties.map((w) => {
            const total = Math.max(
              1,
              Math.round((w.warranty.endsAt - w.warranty.startsAt) / 86_400_000),
            );
            const pct = w.state === 'active' ? Math.min(100, (w.daysLeft / total) * 100) : 0;
            return (
              <li key={w.warranty.id} className="card card-pad flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="primary">{t(dynKey('warranty.kind', w.warranty.kind))}</Badge>
                  <Badge tone={STATE_TONE[w.state]}>{t(dynKey('warranty.state', w.state))}</Badge>
                  <span className="ltr ms-auto text-sm text-muted">
                    {formatDate(w.warranty.startsAt)} → {formatDate(w.warranty.endsAt)}
                  </span>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-surface-2"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={w.daysLeft}
                  aria-label={t('warranty.daysLeft', { n: w.daysLeft })}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${pct}%`,
                      background: `linear-gradient(90deg, var(--success), color-mix(in srgb, var(--success) 60%, #fff))`,
                    }}
                  />
                </div>
                <div className="text-sm font-semibold">
                  {w.state === 'active' ? t('warranty.daysLeft', { n: w.daysLeft }) : null}
                  {w.warranty.note ? (
                    <span className="ms-2 font-normal text-muted">{w.warranty.note}</span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <RegisterDialog open={registering} lookup={lookup} onClose={() => setRegistering(false)} />
    </div>
  );
}

function Lookup(): ReactNode {
  const t = useT();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const result = useServiceQuery((s) => s.warranty.lookup(query), [query], query !== '');
  const notFound = isServiceError(result.error) && result.error.code === 'NOT_FOUND';

  return (
    <section className="flex flex-col gap-3">
      <form
        className="card card-pad flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input.trim());
        }}
      >
        <Field label={t('warranty.lookupLabel')} className="min-w-64 flex-1">
          <div className="relative">
            <ScanLine
              size={18}
              className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="ltr num ps-10 text-lg"
              placeholder={t('warranty.lookupPlaceholder')}
              autoFocus
            />
          </div>
        </Field>
        <Button type="submit" variant="primary" size="lg" disabled={input.trim() === ''}>
          {t('warranty.check')}
        </Button>
      </form>
      {query === '' ? null : result.loading && !result.data ? (
        <div className="card">
          <SkeletonRows rows={3} />
        </div>
      ) : notFound ? (
        <div className="card">
          <Empty
            icon={<ShieldOff size={26} aria-hidden="true" />}
            title={t('warranty.notFound')}
            hint={t('warranty.notFoundHint')}
          />
        </div>
      ) : result.error ? (
        <ErrorBox error={result.error} onRetry={result.reload} />
      ) : result.data ? (
        <LookupResult lookup={result.data} />
      ) : null}
    </section>
  );
}

function Expiring(): ReactNode {
  const t = useT();
  const [win, setWin] = useState<Window>('30');
  const list = useServiceQuery((s) => s.warranty.listExpiring(Number(win)), [win]);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg">{t('warranty.expiring')}</h2>
        <Tabs<Window>
          label={t('warranty.expiring')}
          value={win}
          onChange={setWin}
          items={(['7', '30', '90'] as const).map((d) => ({
            value: d,
            label: t('warranty.nDays', { n: d }),
          }))}
        />
      </div>
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : (
        <div className="tbl-wrap">
          {list.loading && !list.data ? (
            <SkeletonRows rows={4} />
          ) : (list.data ?? []).length === 0 ? (
            <Empty title={t('warranty.noneExpiring')} />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('billing.item')}</th>
                  <th>IMEI / Serial</th>
                  <th>{t('billing.customer')}</th>
                  <th>{t('warranty.invoice')}</th>
                  <th>{t('warranty.kind')}</th>
                  <th>{t('warranty.ends')}</th>
                  <th className="num">{t('warranty.left')}</th>
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((r) => (
                  <tr key={r.status.warranty.id}>
                    <td className="font-medium">{r.unitLabel}</td>
                    <td className="ltr num text-sm">{r.imei ?? r.serial ?? '—'}</td>
                    <td>
                      <div>{r.customerName ?? t('warranty.walkIn')}</div>
                      <div className="ltr text-xs text-muted">{r.customerPhone ?? ''}</div>
                    </td>
                    <td className="ltr text-sm">{r.invoiceNo}</td>
                    <td>
                      <Badge tone="primary">
                        {t(dynKey('warranty.kind', r.status.warranty.kind))}
                      </Badge>
                    </td>
                    <td className="ltr text-sm">{formatDate(r.status.warranty.endsAt)}</td>
                    <td className="num">
                      <Badge tone={r.status.daysLeft <= 7 ? 'danger' : 'warning'}>
                        {t('warranty.nDays', { n: r.status.daysLeft })}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

export function Warranty(): ReactNode {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('nav.warranty')} subtitle={t('warranty.subtitle')} />
      <Lookup />
      <Expiring />
    </div>
  );
}
