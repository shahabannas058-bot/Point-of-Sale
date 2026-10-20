import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { compactRs, niceMax } from '../../lib/dashboard';
import { formatRs } from '../../lib/money';

export interface TrendSeries {
  key: string;
  label: string;
  /** A CSS colour, e.g. var(--chart-1). The first series also gets a soft area fill. */
  color: string;
  values: readonly number[];
}

const HEIGHT = 240;
const PAD = { top: 12, right: 12, bottom: 28, left: 52 };
const TICKS = 4;
const MAX_X_LABELS = 8;
/** Room one x-axis label needs, so labels never touch on a narrow screen. */
const X_LABEL_PX = 56;
const AREA_OPACITY = 0.12;

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Money over time on one shared axis (paisa). Line + soft area for the first series, line for the rest.
 * A crosshair snaps to the nearest point on hover; arrow keys move it when the chart has focus.
 */
export function TrendChart({
  labels,
  series,
  ariaLabel,
}: {
  labels: readonly string[];
  series: readonly TrendSeries[];
  ariaLabel: string;
}): ReactNode {
  const [box, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const all = series.flatMap((s) => s.values);
  const highest = Math.max(0, ...all);
  const lowest = Math.min(0, ...all);
  // one step for both sides, so 0 is always a gridline and the ticks are evenly spaced
  const step = niceMax((highest - lowest) / TICKS);
  const top = Math.max(step, Math.ceil(highest / step) * step);
  const bottom = Math.floor(lowest / step) * step;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number): number => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number): number => PAD.top + ((top - v) / (top - bottom)) * plotH;
  const ticks = Array.from(
    { length: Math.round((top - bottom) / step) + 1 },
    (_, i) => bottom + i * step,
  );
  const maxLabels = Math.max(2, Math.min(MAX_X_LABELS, Math.floor(plotW / X_LABEL_PX)));
  const labelEvery = Math.max(1, Math.ceil(n / maxLabels));

  const path = (vals: readonly number[]): string =>
    vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');

  const pick = (clientX: number, el: SVGSVGElement): void => {
    const left = el.getBoundingClientRect().left;
    const rel = (clientX - left - PAD.left) / Math.max(1, plotW);
    setHover(Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1)))));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    setHover((h) => Math.min(n - 1, Math.max(0, (h ?? (step > 0 ? -1 : n)) + step)));
  };

  const first = series[0];
  const at = hover !== null && hover < n ? hover : null;
  const tipLeft = at === null ? 0 : Math.min(Math.max(x(at), 80), Math.max(80, width - 80));

  return (
    <div ref={box} className="relative w-full min-w-0 overflow-hidden" style={{ height: HEIGHT }}>
      {width > 0 ? (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          className="block outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] rounded-lg"
          onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--border)"
                strokeOpacity={v === 0 ? 1 : 0.55}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(v)}
                dy="0.32em"
                textAnchor="end"
                className="num fill-[var(--text-muted)] text-[11px]"
              >
                {compactRs(v)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            (i % labelEvery === 0 && n - 1 - i >= labelEvery) || i === n - 1 ? (
              <text
                key={l}
                x={x(i)}
                y={HEIGHT - 8}
                textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                className="fill-[var(--text-muted)] text-[11px]"
              >
                {l}
              </text>
            ) : null,
          )}
          {first && n > 1 && first.values.length === n ? (
            <path
              d={`${path(first.values)}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`}
              fill={first.color}
              fillOpacity={AREA_OPACITY}
            />
          ) : null}
          {series.map((s) =>
            s.values.length === n ? (
              <path
                key={s.key}
                d={path(s.values)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null,
          )}
          {at !== null ? (
            <g pointerEvents="none">
              <line
                x1={x(at)}
                x2={x(at)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="var(--text-muted)"
                strokeWidth={1}
              />
              {series.map((s) => (
                <circle
                  key={s.key}
                  cx={x(at)}
                  cy={y(s.values[at] ?? 0)}
                  r={4.5}
                  fill={s.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              ))}
            </g>
          ) : null}
        </svg>
      ) : null}
      {at !== null ? (
        <div
          role="status"
          className="pointer-events-none absolute top-1 z-10 min-w-36 whitespace-nowrap -translate-x-1/2 rounded-xl border border-line bg-[var(--glass-strong)] px-3 py-2 text-xs shadow-lg backdrop-blur"
          style={{ left: tipLeft }}
        >
          <div className="mb-1 font-semibold text-muted">{labels[at]}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span
                className="inline-block h-0.5 w-3 rounded-full"
                style={{ background: s.color }}
                aria-hidden="true"
              />
              <span className="num ltr font-bold text-ink">{formatRs(s.values[at] ?? 0)}</span>
              <span className="text-muted">{s.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChartLegend({
  items,
}: {
  items: readonly { key: string; label: string; color: string }[];
}): ReactNode {
  return (
    <ul className="flex flex-wrap items-center gap-4 text-xs text-muted">
      {items.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-4 rounded-full"
            style={{ background: s.color }}
            aria-hidden="true"
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Horizontal bars of one measure (paisa) with the value at the tip; the hover title carries the exact figure. */
export function BarList({
  rows,
  color = 'var(--chart-1)',
}: {
  rows: readonly { key: string; label: string; value: number }[];
  color?: string;
}): ReactNode {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => (
        <li key={r.key} title={`${r.label}: ${formatRs(r.value)}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium">{r.label}</span>
            <span className="num ltr shrink-0 font-semibold">{formatRs(r.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, Math.round((Math.abs(r.value) / max) * 100))}%`,
                background: r.value < 0 ? 'var(--danger)' : color,
                opacity: r.value === 0 ? 0 : 1,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
