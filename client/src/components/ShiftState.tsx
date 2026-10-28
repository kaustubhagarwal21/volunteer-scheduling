import type { ShiftState } from '../api/types';

export const STATE_LABEL: Record<ShiftState, string> = {
  open: 'Open',
  partially_filled: 'Partially filled',
  filled: 'Filled',
  closed: 'Closed',
};

/** Lifecycle order, used for filters, legends and stacked bars. */
export const STATES: ShiftState[] = ['open', 'partially_filled', 'filled', 'closed'];

/** Background classes for state marks (dots, slots, chart segments). Text always stays ink. */
export const stateFill: Record<ShiftState, string> = {
  open: 'bg-open',
  partially_filled: 'bg-partial',
  filled: 'bg-filled',
  closed: 'bg-closed',
};

const stateRing: Record<ShiftState, string> = {
  open: 'border-open',
  partially_filled: 'border-partial',
  filled: 'border-filled',
  closed: 'border-closed',
};

export function StateDot({ state }: { state: ShiftState }) {
  return <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${stateFill[state]}`} />;
}

export function StateBadge({ state }: { state: ShiftState }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-rule bg-surface px-2 py-0.5 text-xs font-semibold text-ink-soft">
      <StateDot state={state} />
      {STATE_LABEL[state]}
    </span>
  );
}

const MAX_SLOTS_DRAWN = 12;

/**
 * The sign-up sheet in miniature: one slot per volunteer the shift needs, solid when taken,
 * an outline when still open. Large headcounts fall back to a bar so the row stays readable.
 */
export function SlotMeter({ filled, required, state }: { filled: number; required: number; state: ShiftState }) {
  const label = `${filled} of ${required} spots filled`;
  return (
    <span className="inline-flex items-center gap-2" role="img" aria-label={label} title={label}>
      {required <= MAX_SLOTS_DRAWN ? (
        <span className="flex gap-1">
          {Array.from({ length: required }, (_, i) => (
            <span
              key={i}
              className={`size-2.5 rounded-full border-2 ${
                i < filled ? `${stateFill[state]} border-transparent` : `${stateRing[state]} opacity-60`
              }`}
            />
          ))}
        </span>
      ) : (
        <span className="h-2 w-24 overflow-hidden rounded-full bg-rule">
          <span className={`block h-full ${stateFill[state]}`} style={{ width: `${(filled / required) * 100}%` }} />
        </span>
      )}
      <span className="text-sm tabular-nums text-ink-soft">
        {filled}/{required}
      </span>
    </span>
  );
}
