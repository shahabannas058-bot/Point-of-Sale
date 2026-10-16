import type { ReactNode } from 'react';
import {
  PHONE_CONDITIONS,
  PTA_STATUSES,
  type NewPhoneUnitInput,
  type PhoneCondition,
  type PhoneUnitView,
  type PtaStatus,
} from '@pos/shared';
import { dynKey, useT, type TKey } from '../i18n';
import { paisaToInput, parseRupees } from '../lib/money';
import { Field, Input, Select } from './ui/Field';

export interface PhoneDraft {
  brand: string;
  name: string;
  imei1: string;
  imei2: string;
  serial: string;
  colour: string;
  ram: string;
  storage: string;
  battery: string;
  pta: PtaStatus;
  condition: PhoneCondition;
  cost: string;
  price: string;
  note: string;
}

export const emptyPhoneDraft = (): PhoneDraft => ({
  brand: '',
  name: '',
  imei1: '',
  imei2: '',
  serial: '',
  colour: '',
  ram: '',
  storage: '',
  battery: '',
  pta: 'approved',
  condition: 'new',
  cost: '',
  price: '',
  note: '',
});

export const draftFromView = (v: PhoneUnitView): PhoneDraft => ({
  brand: v.product.brand,
  name: v.product.name,
  imei1: v.unit.imei1 ?? '',
  imei2: v.unit.imei2 ?? '',
  serial: v.unit.serial ?? '',
  colour: v.unit.colour ?? '',
  ram: v.unit.ramGb ? String(v.unit.ramGb) : '',
  storage: v.unit.storageGb ? String(v.unit.storageGb) : '',
  battery: v.unit.batteryHealthPct !== null ? String(v.unit.batteryHealthPct) : '',
  pta: v.unit.ptaStatus,
  condition: v.unit.condition,
  cost: paisaToInput(v.unit.costPrice),
  price: paisaToInput(v.unit.salePrice),
  note: v.unit.note ?? '',
});

const posInt = (s: string): number | null => {
  const n = Number(s.trim());
  return s.trim() !== '' && Number.isInteger(n) && n > 0 ? n : null;
};

export function draftToInput(d: PhoneDraft): { input: NewPhoneUnitInput } | { error: TKey } {
  if (!d.brand.trim() || !d.name.trim()) return { error: 'inv.errProduct' };
  if (!d.imei1.trim() && !d.serial.trim()) return { error: 'inv.errImei' };
  if (d.imei1 && d.imei1.length !== 15) return { error: 'inv.errImeiLen' };
  if (d.imei2 && d.imei2.length !== 15) return { error: 'inv.errImeiLen' };
  const cost = parseRupees(d.cost);
  const price = parseRupees(d.price);
  if (cost === null || price === null) return { error: 'inv.errPrice' };
  const battery = d.battery.trim() === '' ? null : Number(d.battery);
  if (battery !== null && (!Number.isInteger(battery) || battery < 0 || battery > 100))
    return { error: 'inv.errBattery' };
  return {
    input: {
      product: { brand: d.brand.trim(), name: d.name.trim(), category: 'Smartphone' },
      imei1: d.imei1 || null,
      imei2: d.imei2 || null,
      serial: d.serial.trim() || null,
      colour: d.colour.trim() || null,
      ramGb: posInt(d.ram),
      storageGb: posInt(d.storage),
      batteryHealthPct: d.condition === 'new' ? null : battery,
      ptaStatus: d.pta,
      condition: d.condition,
      costPrice: cost,
      salePrice: price,
      note: d.note.trim() || null,
    },
  };
}

const digits = (v: string): string => v.replace(/\D/g, '').slice(0, 15);

/** Shared phone fields (add dialog, edit dialog, receive-stock rows). `lockIdentity` disables fields the service cannot change. */
export function PhoneFields({
  draft,
  onChange,
  lockIdentity = false,
  compact = false,
}: {
  draft: PhoneDraft;
  onChange: (d: PhoneDraft) => void;
  lockIdentity?: boolean;
  compact?: boolean;
}): ReactNode {
  const t = useT();
  const set = <K extends keyof PhoneDraft>(k: K, v: PhoneDraft[K]): void =>
    onChange({ ...draft, [k]: v });
  const cols = compact ? 'sm:grid-cols-4' : 'sm:grid-cols-3';
  return (
    <div className={`grid gap-3 ${cols}`}>
      <Field label={t('inv.brand')}>
        <Input
          value={draft.brand}
          onChange={(e) => set('brand', e.target.value)}
          disabled={lockIdentity}
          data-autofocus={!lockIdentity ? true : undefined}
        />
      </Field>
      <Field label={t('inv.model')}>
        <Input
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          disabled={lockIdentity}
        />
      </Field>
      <Field label={t('inv.colour')}>
        <Input value={draft.colour} onChange={(e) => set('colour', e.target.value)} />
      </Field>
      <Field label="IMEI 1" hint={`${draft.imei1.length}/15`}>
        <Input
          value={draft.imei1}
          onChange={(e) => set('imei1', digits(e.target.value))}
          inputMode="numeric"
          className="ltr font-mono"
          disabled={lockIdentity}
          maxLength={15}
        />
      </Field>
      <Field label="IMEI 2">
        <Input
          value={draft.imei2}
          onChange={(e) => set('imei2', digits(e.target.value))}
          inputMode="numeric"
          className="ltr font-mono"
          disabled={lockIdentity}
          maxLength={15}
        />
      </Field>
      <Field label={t('inv.serial')}>
        <Input
          value={draft.serial}
          onChange={(e) => set('serial', e.target.value)}
          className="ltr"
          disabled={lockIdentity}
        />
      </Field>
      <Field label={t('inv.ram')}>
        <Input
          value={draft.ram}
          onChange={(e) => set('ram', e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          className="ltr"
          disabled={lockIdentity}
        />
      </Field>
      <Field label={t('inv.storage')}>
        <Input
          value={draft.storage}
          onChange={(e) => set('storage', e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          className="ltr"
          disabled={lockIdentity}
        />
      </Field>
      <Field label={t('inv.pta')}>
        <Select value={draft.pta} onChange={(e) => set('pta', e.target.value as PtaStatus)}>
          {PTA_STATUSES.map((p) => (
            <option key={p} value={p}>
              {t(dynKey('pta', p))}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('inv.condition')}>
        <Select
          value={draft.condition}
          onChange={(e) => set('condition', e.target.value as PhoneCondition)}
        >
          {PHONE_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {t(dynKey('condition', c))}
            </option>
          ))}
        </Select>
      </Field>
      {draft.condition !== 'new' ? (
        <Field label={t('inv.battery')}>
          <Input
            value={draft.battery}
            onChange={(e) => set('battery', e.target.value.replace(/\D/g, '').slice(0, 3))}
            inputMode="numeric"
            className="ltr"
          />
        </Field>
      ) : null}
      <Field label={t('inv.cost')}>
        <Input
          value={draft.cost}
          onChange={(e) => set('cost', e.target.value)}
          inputMode="decimal"
          className="ltr"
        />
      </Field>
      <Field label={t('inv.price')}>
        <Input
          value={draft.price}
          onChange={(e) => set('price', e.target.value)}
          inputMode="decimal"
          className="ltr"
        />
      </Field>
      {!compact ? (
        <Field label={t('inv.note')} className="sm:col-span-3">
          <Input value={draft.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
      ) : null}
    </div>
  );
}
