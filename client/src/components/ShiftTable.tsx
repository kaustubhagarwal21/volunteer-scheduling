import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { Shift, ShiftListItem } from '../api/types';
import { useAction } from '../api/useAction';
import { useAuth } from '../auth/AuthContext';
import { formatDate, formatTime } from '../lib/format';
import { SlotMeter, StateBadge } from './ShiftState';
import { Button } from './ui';

export function TimeRange({ shift }: { shift: Pick<Shift, 'startTime' | 'endTime' | 'endDate'> }) {
  return (
    <span className="whitespace-nowrap">
      {formatTime(shift.startTime)} – {formatTime(shift.endTime)}
      {shift.endDate && <span className="text-muted"> (+1 day)</span>}
    </span>
  );
}

/** The standard list of shifts. `actions` renders the last column (e.g. sign up / dismiss). */
export function ShiftTable({
  shifts,
  showProgram = true,
  actions,
}: {
  shifts: (Shift | ShiftListItem)[];
  showProgram?: boolean;
  actions?: (shift: Shift | ShiftListItem) => ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="border-b border-rule text-muted">
          <tr>
            <th className="px-4 py-2 font-semibold">Date</th>
            <th className="px-4 py-2 font-semibold">Time</th>
            {showProgram && <th className="px-4 py-2 font-semibold">Program</th>}
            <th className="px-4 py-2 font-semibold">Location</th>
            <th className="px-4 py-2 font-semibold">Spots</th>
            <th className="px-4 py-2 font-semibold">State</th>
            {actions && <th className="px-4 py-2" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {shifts.map((shift) => (
            <tr key={shift.id} className={`border-b border-rule last:border-0 ${shift.hasEnded ? 'text-muted' : ''}`}>
              <td className="whitespace-nowrap px-4 py-2.5">
                <Link to={`/shifts/${shift.id}`} className="font-semibold text-ink underline-offset-2 hover:underline">
                  {formatDate(shift.date)}
                </Link>
              </td>
              <td className="px-4 py-2.5">
                <TimeRange shift={shift} />
              </td>
              {showProgram && (
                <td className="px-4 py-2.5">
                  <Link to={`/programs/${shift.programId}`} className="hover:underline">
                    {shift.programName}
                  </Link>
                </td>
              )}
              <td className="px-4 py-2.5">{shift.location}</td>
              <td className="px-4 py-2.5">
                <SlotMeter filled={shift.signupCount} required={shift.requiredHeadcount} state={shift.state} />
              </td>
              <td className="px-4 py-2.5">
                <StateBadge state={shift.state} />
              </td>
              {actions && <td className="px-4 py-2.5 text-right">{actions(shift)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A volunteer's own action on a shift row: sign up, or cancel their signup. The buttons only appear
 * when the move is allowed, but the server re-checks every rule and explains any refusal.
 */
export function VolunteerShiftAction({ shift }: { shift: ShiftListItem }) {
  const { isCoordinator } = useAuth();
  const signUp = useAction(() => api('POST', `/shifts/${shift.id}/signups`, {}), { success: 'You are signed up.' });
  const cancel = useAction(() => api('POST', `/signups/${shift.mySignupId}/cancel`), {
    success: 'Your signup was cancelled.',
  });

  if (isCoordinator || shift.state === 'closed' || shift.hasStarted) return null;
  if (shift.mySignupId) {
    return (
      <Button size="sm" variant="quiet" busy={cancel.isPending} onClick={() => cancel.mutate()}>
        Cancel my signup
      </Button>
    );
  }
  if (shift.state === 'filled') return <span className="text-sm text-muted">Full</span>;
  return (
    <Button size="sm" variant="primary" busy={signUp.isPending} onClick={() => signUp.mutate()}>
      Sign up
    </Button>
  );
}
