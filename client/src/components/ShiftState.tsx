import type { ShiftState } from '../api/types';

export const STATE_LABEL: Record<ShiftState, string> = {
  open: 'Open',
  partially_filled: 'Partially filled',
  filled: 'Filled',
  closed: 'Closed',
};

/** Lifecycle order, used for filters and legends. */
export const STATES: ShiftState[] = ['open', 'partially_filled', 'filled', 'closed'];

const badgeStyle: Record<ShiftState, string> = {
  open: 'text-open bg-open-tint border-open/25',
  partially_filled: 'text-partial bg-partial-tint border-partial/25',
  filled: 'text-filled bg-filled-tint border-filled/25',
  closed: 'text-closed bg-closed-tint border-closed/25',
};

export const stateFill: Record<ShiftState, string> = {
  open: 'bg-open',
  partially_filled: 'bg-partial',
  filled: 'bg-filled',
  closed: 'bg-closed',
};

const stateRing: Record<ShiftState, string> = {
  open: 'border-open/50',
  partially_filled: 'border-partial/50',
  filled: 'border-filled/50',
  closed: 'border-closed/40',
};

export function StateBadge({ state }: { state: ShiftState }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${badgeStyle[state]}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

const MAX_SLOTS_DRAWN = 12;

/**
 * The sign-up sheet in miniature: one slot per volunteer the shift needs, solid when taken.
 * Large headcounts fall back to a bar so the row stays readable.
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
              className={`size-2.5 rounded-full border ${i < filled ? `${stateFill[state]} border-transparent` : stateRing[state]}`}
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
