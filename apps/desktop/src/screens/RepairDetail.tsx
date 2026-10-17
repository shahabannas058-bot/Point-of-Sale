import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Ban, Check, PackagePlus, Pencil, PackageCheck } from 'lucide-react';
import { REPAIR_TRANSITIONS, type RepairStatus, type RepairTicketView } from '@pos/shared';
import {
  AddPartDialog,
  CancelRepairDialog,
  DeliverDialog,
  EditChargesDialog,
} from '../components/repairs/RepairActions';
import { REPAIR_FLOW, RepairStatusBadge, isClosed, statusKey } from '../components/repairs/status';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Empty, ErrorBox, Money, PageHeader, SkeletonRows } from '../components/ui/misc';
import { dynKey, useT } from '../i18n';
import { errorMessage } from '../i18n/errors';
import { formatDate, formatDateTime } from '../lib/dates';
import { useService } from '../service/context';
import { useServiceQuery } from '../service/use-query';
import { useDataVersion } from '../store/data-version';
import { toast } from '../store/toast';

type Open = 'part' | 'charges' | 'deliver' | 'cancel' | null;

function Stepper({
  view,
  busy,
  onMove,
  onDeliver,
}: {
  view: RepairTicketView;
  busy: boolean;
  onMove: (s: RepairStatus) => void;
  onDeliver: () => void;
}): ReactNode {
  const t = useT();
  const current = view.ticket.status;
  const at = REPAIR_FLOW.indexOf(current);
  return (
    <div className="stepper" role="group" aria-label={t('repair.statusCol')}>
      {REPAIR_FLOW.map((s, i) => {
        const state =
          current === 'cancelled' ? 'todo' : i < at ? 'done' : i === at ? 'current' : 'todo';
        const canMove =
          !busy &&
          (s === 'delivered' ? current === 'ready' : REPAIR_TRANSITIONS[current].includes(s));
        return (
          <button
            key={s}
            type="button"
            className="step"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            disabled={!canMove}
            onClick={() => (s === 'delivered' ? onDeliver() : onMove(s))}
          >
            {state === 'done' ? <Check size={14} aria-hidden="true" /> : <span className="dot" />}
            {t(statusKey(s))}
          </button>
        );
      })}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

function TicketBody({ view }: { view: RepairTicketView }): ReactNode {
  const t = useT();
  const service = useService();
  const bump = useDataVersion((s) => s.bump);
  const [open, setOpen] = useState<Open>(null);
  const [moving, setMoving] = useState(false);
  const tk = view.ticket;
  const closed = isClosed(tk.status);
  const partsTotal = view.parts.reduce((n, p) => n + p.unitPrice * p.quantity, 0);

  const move = async (status: RepairStatus): Promise<void> => {
    if (status === 'delivered' || status === 'cancelled') return;
    setMoving(true);
    try {
      await service.repairs.setStatus({ ticketId: tk.id, status });
      bump();
      toast.success(t('repair.moved', { status: t(statusKey(status)) }));
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setMoving(false);
    }
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="ltr">{tk.ticketNo}</span>
            <RepairStatusBadge status={tk.status} />
          </span>
        }
        subtitle={`${tk.deviceBrand} ${tk.deviceModel} · ${tk.customerName}`}
        actions={
          <>
            <Link to="/repairs" className="btn btn-ghost">
              <ArrowLeft size={16} aria-hidden="true" className="rtl:-scale-x-100" />
              {t('nav.repairs')}
            </Link>
            {!closed ? (
              <>
                <Button onClick={() => setOpen('charges')}>
                  <Pencil size={16} aria-hidden="true" />
                  {t('repair.editCharges')}
                </Button>
                <Button variant="danger-outline" onClick={() => setOpen('cancel')}>
                  <Ban size={16} aria-hidden="true" />
                  {t('repair.cancelTicket')}
                </Button>
                <Button
                  variant="success"
                  disabled={tk.status !== 'ready'}
                  title={tk.status !== 'ready' ? t('repair.deliverNeedsReady') : undefined}
                  onClick={() => setOpen('deliver')}
                >
                  <PackageCheck size={16} aria-hidden="true" />
                  {t('repair.deliver')}
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="mb-4">
        {tk.status === 'cancelled' ? (
          <div className="glass-hero" style={{ ['--tone' as string]: 'var(--danger-soft)' }}>
            <div className="font-semibold text-[var(--danger-ink)]">
              {t('repair.cancelledBanner')}
            </div>
          </div>
        ) : (
          <Stepper
            view={view}
            busy={moving}
            onMove={(s) => void move(s)}
            onDeliver={() => setOpen('deliver')}
          />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="card card-pad">
            <div className="panel-title mb-3">{t('repair.secDevice')}</div>
            <dl className="m-0 grid gap-4 sm:grid-cols-3">
              <InfoRow label={t('billing.customer')}>
                <div className="font-semibold">
                  {tk.customerId ? (
                    <Link to={`/customers/${tk.customerId}`} className="text-[var(--primary-ink)]">
                      {tk.customerName}
                    </Link>
                  ) : (
                    tk.customerName
                  )}
                </div>
                <div className="ltr text-sm text-muted">{tk.customerPhone ?? ''}</div>
              </InfoRow>
              <InfoRow label={t('repair.device')}>
                {tk.deviceBrand} {tk.deviceModel}
              </InfoRow>
              <InfoRow label="IMEI / Serial">
                <span className="ltr num">{tk.imei ?? tk.serial ?? '—'}</span>
              </InfoRow>
              <InfoRow label={t('repair.promised')}>
                <span className="ltr">{tk.promisedAt ? formatDate(tk.promisedAt) : '—'}</span>
              </InfoRow>
              <InfoRow label={t('repair.condition')}>{tk.conditionNotes ?? '—'}</InfoRow>
              <InfoRow label={t('repair.accessories')}>{tk.accessories ?? '—'}</InfoRow>
            </dl>
            <div className="mt-4 rounded-2xl bg-surface-2/60 p-3">
              <div className="text-xs font-semibold text-muted">{t('repair.problem')}</div>
              <div className="mt-1 whitespace-pre-wrap">{tk.problem}</div>
            </div>
          </section>

          <section className="card">
            <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
              <div className="panel-title">{t('repair.parts')}</div>
              {!closed ? (
                <Button size="sm" onClick={() => setOpen('part')}>
                  <PackagePlus size={16} aria-hidden="true" />
                  {t('repair.addPart')}
                </Button>
              ) : null}
            </div>
            {view.parts.length === 0 ? (
              <Empty title={t('repair.noParts')} hint={t('repair.noPartsHint')} />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('billing.item')}</th>
                    <th className="num">{t('billing.qty')}</th>
                    <th className="num">{t('repair.partPrice')}</th>
                    <th>{t('repair.when')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.parts.map((p) => (
                    <tr key={p.id}>
                      <td className="font-medium">{p.label}</td>
                      <td className="num">{p.quantity}</td>
                      <td className="num">
                        <Money value={p.unitPrice * p.quantity} />
                      </td>
                      <td className="ltr text-sm text-muted">{formatDateTime(p.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card">
            <div className="panel-title px-4 pt-4 pb-2">{t('repair.payments')}</div>
            {view.payments.length === 0 ? (
              <Empty title={t('repair.noPayments')} />
            ) : (
              <table className="tbl">
                <tbody>
                  {view.payments.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Badge
                          tone={
                            p.kind === 'refund'
                              ? 'warning'
                              : p.kind === 'advance'
                                ? 'primary'
                                : 'success'
                          }
                        >
                          {t(dynKey('repair.pay', p.kind))}
                        </Badge>
                      </td>
                      <td>{t(dynKey('method', p.method))}</td>
                      <td className="ltr text-sm text-muted">{formatDateTime(p.createdAt)}</td>
                      <td className="num font-semibold">
                        <Money value={p.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-4">
          <div className="slip card-pad flex flex-col gap-2">
            <div className="slip-row">
              <span>{t('repair.estimate')}</span>
              <b>
                <Money value={tk.estimatedCost} />
              </b>
            </div>
            <div className="slip-row">
              <span>{t('repair.finalCharge')}</span>
              <b>{tk.finalCharge === null ? '—' : <Money value={tk.finalCharge} />}</b>
            </div>
            <div className="slip-row">
              <span>{t('repair.partsValue')}</span>
              <b>
                <Money value={partsTotal} />
              </b>
            </div>
            <div className="slip-row">
              <span>{t('repair.paid')}</span>
              <b>
                <Money value={view.paidTotal} />
              </b>
            </div>
            <hr className="my-1 border-0 border-t border-dashed border-line" />
            <div className="slip-row">
              <span>{t('repair.balanceDue')}</span>
            </div>
            <div className={`slip-total ${view.balanceDue < 0 ? 'text-[var(--warning-ink)]' : ''}`}>
              <Money value={view.balanceDue} />
            </div>
            {view.technicianName ? (
              <div className="text-sm text-muted">
                {t('repair.technician')}: <b className="text-ink">{view.technicianName}</b>
              </div>
            ) : null}
          </div>

          <section className="card card-pad">
            <div className="panel-title mb-3">{t('repair.history')}</div>
            <ol className="timeline m-0">
              {[...view.history].reverse().map((h) => (
                <li key={h.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <RepairStatusBadge status={h.toStatus} />
                    <span className="ltr text-xs text-muted">{formatDateTime(h.changedAt)}</span>
                  </div>
                  <div className="mt-0.5 text-sm text-muted">{h.changedByName}</div>
                  {h.note ? <div className="mt-0.5 text-sm">{h.note}</div> : null}
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>

      <AddPartDialog open={open === 'part'} view={view} onClose={() => setOpen(null)} />
      <EditChargesDialog open={open === 'charges'} view={view} onClose={() => setOpen(null)} />
      <DeliverDialog open={open === 'deliver'} view={view} onClose={() => setOpen(null)} />
      <CancelRepairDialog open={open === 'cancel'} view={view} onClose={() => setOpen(null)} />
    </>
  );
}

export function RepairDetail(): ReactNode {
  const { id = '' } = useParams();
  const q = useServiceQuery((s) => s.repairs.get(id), [id]);
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data)
    return (
      <div className="card">
        <SkeletonRows />
      </div>
    );
  return <TicketBody view={q.data} />;
}
