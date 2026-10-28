import { useState } from 'react';
import type { ShiftState } from '../api/types';
import { plural } from '../lib/format';
import { STATE_LABEL, STATES, StateDot, stateFill } from './ShiftState';

/**
 * Part-to-whole: how many shifts are in each fill state. One horizontal bar split into state
 * segments (2px surface gap between them), with a legend that also carries every count, so no value
 * depends on hovering.
 */
export function StateBreakdownBar({ counts }: { counts: Record<ShiftState, number> }) {
  const [active, setActive] = useState<ShiftState | null>(null);
  const total = STATES.reduce((sum, state) => sum + counts[state], 0);
  if (total === 0) return <p className="text-sm text-muted">No shifts yet.</p>;

  const percent = (n: number) => Math.round((n / total) * 100);
  return (
    <div>
      <p className="mb-2 h-5 text-sm text-ink-soft" aria-live="polite">
        {active ? `${STATE_LABEL[active]}: ${plural(counts[active], 'shift')} (${percent(counts[active])}%)` : `${plural(total, 'shift')} in total`}
      </p>
      <div className="flex h-5 gap-[2px]" role="img" aria-label="Shifts by fill state">
        {STATES.filter((state) => counts[state] > 0).map((state) => (
          <span
            key={state}
            tabIndex={0}
            onPointerEnter={() => setActive(state)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(state)}
            onBlur={() => setActive(null)}
            aria-label={`${STATE_LABEL[state]}: ${counts[state]}`}
            className={`h-full first:rounded-l last:rounded-r ${stateFill[state]} ${
              active && active !== state ? 'opacity-40' : ''
            } transition-opacity`}
            style={{ width: `${(counts[state] / total) * 100}%`, minWidth: '6px' }}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {STATES.map((state) => (
          <li key={state} className="flex items-center gap-1.5">
            <StateDot state={state} />
            <span className="text-ink-soft">{STATE_LABEL[state]}</span>
            <span className="font-semibold tabular-nums">{counts[state]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const WIDTH = 560;
const HEIGHT = 220;
const PLOT = { top: 22, right: 8, bottom: 28, left: 32 };

/**
 * Clean axis ticks for whole-number counts: a step of 1, 2 or 5 (or 25) times a power of ten, and
 * three to five intervals — whichever combination puts the top of the axis closest above the data.
 */
function niceScale(max: number): { top: number; step: number } {
  if (max <= 4) return { top: 4, step: 1 };
  let best = { top: Infinity, step: 1 };
  for (const intervals of [3, 4, 5]) {
    const raw = max / intervals;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const multipliers = magnitude >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
    const step = multipliers.map((m) => m * magnitude).find((s) => s >= raw)!;
    if (step * intervals < best.top) best = { top: step * intervals, step };
  }
  return best;
}

/** A column with a 4px rounded top and a square foot on the baseline. */
function columnPath(x: number, y: number, width: number, baseline: number): string {
  const r = Math.min(4, width / 2, baseline - y);
  return `M${x},${baseline} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${baseline} Z`;
}

const weekLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const formatWeek = (isoDate: string) => weekLabel.format(new Date(`${isoDate}T00:00:00Z`));

/** Signups made per week, oldest first; the last column is the current week. */
export function WeeklySignupsChart({ weeks }: { weeks: { weekStart: string; signups: number }[] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(...weeks.map((w) => w.signups), 0);
  const { top, step } = niceScale(max);
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);

  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const baseline = HEIGHT - PLOT.bottom;
  const band = plotWidth / weeks.length;
  const columnWidth = Math.min(24, band * 0.55);
  const yFor = (value: number) => baseline - (value / top) * (baseline - PLOT.top);

  // Label selectively: the current week and the busiest week, not every column.
  const maxIndex = weeks.findIndex((w) => w.signups === max);
  const labelled = new Set([weeks.length - 1, maxIndex]);

  const readout =
    active === null
      ? `${plural(weeks.reduce((sum, w) => sum + w.signups, 0), 'signup')} over the last ${weeks.length} weeks`
      : `Week of ${formatWeek(weeks[active].weekStart)}: ${plural(weeks[active].signups, 'signup')}`;

  return (
    <div>
      <p className="mb-1 h-5 text-sm text-ink-soft" aria-live="polite">
        {readout}
      </p>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Signups per week">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={yFor(tick)} y2={yFor(tick)} stroke="var(--color-rule)" />
            <text x={PLOT.left - 6} y={yFor(tick) + 4} textAnchor="end" className="fill-muted text-[11px] tabular-nums">
              {tick}
            </text>
          </g>
        ))}
        {weeks.map((week, i) => {
          const x = PLOT.left + i * band + (band - columnWidth) / 2;
          const y = yFor(week.signups);
          return (
            <g
              key={week.weekStart}
              tabIndex={0}
              aria-label={`Week of ${formatWeek(week.weekStart)}: ${week.signups} signups`}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="outline-none"
            >
              {/* The hit area is the whole band, not just the painted column. */}
              <rect x={PLOT.left + i * band} y={PLOT.top} width={band} height={baseline - PLOT.top} fill="transparent" />
              {week.signups > 0 && (
                <path
                  d={columnPath(x, y, columnWidth, baseline)}
                  fill="var(--color-series)"
                  opacity={active !== null && active !== i ? 0.45 : 1}
                />
              )}
              {labelled.has(i) && week.signups > 0 && (
                <text x={x + columnWidth / 2} y={y - 6} textAnchor="middle" className="fill-ink text-[11px] font-semibold">
                  {week.signups}
                </text>
              )}
              <text
                x={x + columnWidth / 2}
                y={HEIGHT - 8}
                textAnchor="middle"
                className={`text-[11px] ${i === weeks.length - 1 ? 'fill-ink font-semibold' : 'fill-muted'}`}
              >
                {i === weeks.length - 1 ? 'This week' : formatWeek(week.weekStart)}
              </text>
            </g>
          );
        })}
        <line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={baseline} y2={baseline} stroke="var(--color-rule-strong)" />
      </svg>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted">Show as table</summary>
        <table className="mt-2 w-full max-w-xs text-left">
          <thead className="text-muted">
            <tr>
              <th className="py-1 font-semibold">Week starting</th>
              <th className="py-1 text-right font-semibold">Signups</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week.weekStart} className="border-t border-rule">
                <td className="py-1">{formatWeek(week.weekStart)}</td>
                <td className="py-1 text-right tabular-nums">{week.signups}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
