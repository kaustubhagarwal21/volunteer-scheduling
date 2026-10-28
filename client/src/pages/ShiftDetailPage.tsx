import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api/client';
import type { Member, Shift, ShiftDetail, TimelineEntry } from '../api/types';
import { useAction } from '../api/useAction';
import { useAuth } from '../auth/AuthContext';
import { Dialog } from '../components/Dialog';
import { ShiftForm, type ShiftFormValues } from '../components/ShiftForm';
import { SlotMeter, STATE_LABEL, StateBadge, StateDot } from '../components/ShiftState';
import { TimeRange } from '../components/ShiftTable';
import { Button, EmptyState, ErrorBanner, Field, Loading, PageHeader, Panel, Select, Textarea } from '../components/ui';
import { formatDate, formatDuration, formatTimestamp, plural } from '../lib/format';

export function ShiftDetailPage() {
  const shiftId = Number(useParams().id);
  const detail = useQuery({ queryKey: ['shift', shiftId], queryFn: () => api<ShiftDetail>('GET', `/shifts/${shiftId}`) });

  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorBanner error={detail.error} />;
  const { shift } = detail.data;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {formatDate(shift.date)} <StateBadge state={shift.state} />
          </span>
        }
        meta={
          <>
            <Link to={`/programs/${shift.programId}`} className="font-semibold text-ink hover:underline">
              {shift.programName}
            </Link>
            {', '}
            <TimeRange shift={shift} /> ({formatDuration(shift.durationMinutes)}), {shift.location}
          </>
        }
      />
      <StatusNotes shift={shift} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-6">
          <StaffingPanel detail={detail.data} />
          <ActionsPanel detail={detail.data} />
        </div>
        <TimelinePanel shift={shift} />
      </div>
    </>
  );
}

function StatusNotes({ shift }: { shift: Shift }) {
  const notes: string[] = [];
  if (shift.deletedAt) notes.push('This shift was deleted. Its history is kept and shown read-only.');
  else if (shift.programArchived) notes.push(`${shift.programName} is archived, so this shift is read-only until it is restored.`);
  else if (shift.state === 'closed') notes.push('This shift is closed: its signups are final.');
  else if (shift.hasEnded) notes.push('This shift is over and waiting to be closed by a coordinator.');
  else if (shift.hasStarted) notes.push('This shift is under way.');
  if (notes.length === 0) return null;
  return <p className="mb-6 rounded-md border border-rule bg-surface px-4 py-3 text-sm text-ink-soft">{notes.join(' ')}</p>;
}

function StaffingPanel({ detail }: { detail: ShiftDetail }) {
  const { isCoordinator, user } = useAuth();
  const { shift, signups } = detail;
  const locked = shift.state === 'closed' || Boolean(shift.deletedAt) || shift.programArchived;
  const cancel = useAction((signupId: number) => api('POST', `/signups/${signupId}/cancel`), {
    success: 'Signup cancelled.',
  });

  return (
    <Panel className="p-5">
      <h2 className="mb-3 font-bold">Who's signed up</h2>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SlotMeter filled={shift.signupCount} required={shift.requiredHeadcount} state={shift.state} />
        <span className="text-sm text-muted">
          {shift.spotsLeft > 0 ? `${plural(shift.spotsLeft, 'spot')} still needed` : 'Every spot is taken'}
        </span>
      </div>
      {signups.length === 0 ? (
        <p className="text-sm text-muted">Nobody yet.</p>
      ) : (
        <ul className="divide-y divide-rule">
          {signups.map((signup) => {
            const canCancel = !locked && (isCoordinator || (signup.volunteer.id === user?.id && !shift.hasStarted));
            return (
              <li key={signup.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <p className="font-semibold">
                    {signup.volunteer.name}
                    {signup.volunteer.id === user?.id && <span className="font-normal text-muted"> (you)</span>}
                  </p>
                  {signup.volunteer.email && <p className="text-sm text-muted">{signup.volunteer.email}</p>}
                  {signup.createdBy.id !== signup.volunteer.id && (
                    <p className="text-sm text-muted">Signed up by {signup.createdBy.name}</p>
                  )}
                </div>
                {canCancel && (
                  <Button size="sm" variant="quiet" busy={cancel.isPending} onClick={() => cancel.mutate(signup.id)}>
                    Cancel
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function ActionsPanel({ detail }: { detail: ShiftDetail }) {
  const { isCoordinator } = useAuth();
  const { shift } = detail;
  if (shift.deletedAt || shift.programArchived) return null;
  return isCoordinator ? <CoordinatorActions detail={detail} /> : <VolunteerActions detail={detail} />;
}

function VolunteerActions({ detail }: { detail: ShiftDetail }) {
  const { shift, mySignupId } = detail;
  const signUp = useAction(() => api('POST', `/shifts/${shift.id}/signups`, {}), { success: 'You are signed up.' });
  const cancel = useAction(() => api('POST', `/signups/${mySignupId}/cancel`), { success: 'Your signup was cancelled.' });

  let body;
  if (shift.state === 'closed') body = <p className="text-sm text-muted">This shift is closed.</p>;
  else if (shift.hasStarted) {
    body = (
      <p className="text-sm text-muted">
        This shift has started, so signups and cancellations go through a coordinator now.
      </p>
    );
  } else if (mySignupId) {
    body = (
      <Button variant="danger" busy={cancel.isPending} onClick={() => cancel.mutate()}>
        Cancel my signup
      </Button>
    );
  } else if (shift.state === 'filled') {
    body = <p className="text-sm text-muted">Every spot is taken. If someone cancels, it opens up again.</p>;
  } else {
    body = (
      <Button variant="primary" busy={signUp.isPending} onClick={() => signUp.mutate()}>
        Sign up for this shift
      </Button>
    );
  }
  return (
    <Panel className="p-5">
      <h2 className="mb-3 font-bold">Your place</h2>
      {body}
    </Panel>
  );
}

function CoordinatorActions({ detail }: { detail: ShiftDetail }) {
  const { shift, signups } = detail;
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [volunteerId, setVolunteerId] = useState('');

  const members = useQuery({
    queryKey: ['members', shift.programId],
    queryFn: () => api<{ members: Member[] }>('GET', `/programs/${shift.programId}/members`),
  });
  const available = (members.data?.members ?? []).filter((m) => !signups.some((s) => s.volunteer.id === m.id));

  const signUp = useAction(() => api('POST', `/shifts/${shift.id}/signups`, { volunteerId: Number(volunteerId) }), {
    success: 'Volunteer signed up.',
    onSuccess: () => setVolunteerId(''),
  });
  const close = useAction(() => api('POST', `/shifts/${shift.id}/close`), { success: 'Shift closed.' });
  const remove = useAction(() => api<{ cancelledSignups: number }>('DELETE', `/shifts/${shift.id}`), {
    success: (result) => `Shift deleted${result.cancelledSignups ? ` and ${plural(result.cancelledSignups, 'signup')} cancelled` : ''}.`,
    onSuccess: () => navigate(`/programs/${shift.programId}`),
  });
  const edit = useAction((changes: Partial<ShiftFormValues>) => api('PATCH', `/shifts/${shift.id}`, changes), {
    success: 'Shift updated.',
    onSuccess: () => setEditing(false),
  });

  if (shift.state === 'closed') {
    return (
      <Panel className="p-5 text-sm text-muted">Closed shifts can't be changed, but you can still add notes.</Panel>
    );
  }

  const initial: ShiftFormValues = {
    date: shift.date,
    startTime: shift.startTime,
    durationMinutes: shift.durationMinutes,
    location: shift.location,
    requiredHeadcount: shift.requiredHeadcount,
  };

  return (
    <Panel className="space-y-5 p-5">
      <h2 className="font-bold">Coordinator actions</h2>

      {shift.state !== 'filled' && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            signUp.mutate();
          }}
        >
          <div className="min-w-48 flex-1">
            <Field label="Sign up a member">
              <Select required value={volunteerId} onChange={(e) => setVolunteerId(e.target.value)}>
                <option value="">Choose a volunteer…</option>
                {available.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" variant="primary" busy={signUp.isPending} disabled={!volunteerId}>
            Sign up
          </Button>
        </form>
      )}

      <div className="flex flex-wrap gap-2">
        {shift.hasEnded && (
          <Button variant="primary" busy={close.isPending} onClick={() => close.mutate()}>
            Close shift
          </Button>
        )}
        <Button onClick={() => setEditing(true)}>Edit details</Button>
        {!shift.hasStarted && (
          <Button
            variant="danger"
            busy={remove.isPending}
            onClick={() => {
              const warning = shift.signupCount
                ? ` Its ${plural(shift.signupCount, 'signup')} will be cancelled.`
                : '';
              if (window.confirm(`Delete this shift?${warning} Its history is kept.`)) remove.mutate();
            }}
          >
            Delete shift
          </Button>
        )}
      </div>
      {!shift.hasEnded && (
        <p className="text-sm text-muted">The shift can be closed once it has ended.</p>
      )}

      <Dialog open={editing} title="Edit shift" onClose={() => setEditing(false)}>
        <ShiftForm
          initial={initial}
          submitLabel="Save changes"
          busy={edit.isPending}
          onSubmit={(values) => {
            // Send only what changed; the server records each change on the timeline.
            const changes = Object.fromEntries(
              (Object.keys(values) as (keyof ShiftFormValues)[])
                .filter((key) => values[key] !== initial[key])
                .map((key) => [key, values[key]]),
            );
            if (Object.keys(changes).length === 0) setEditing(false);
            else edit.mutate(changes);
          }}
        />
      </Dialog>
    </Panel>
  );
}

function TimelinePanel({ shift }: { shift: Shift }) {
  const { isCoordinator, orgTimezone } = useAuth();
  const timeline = useQuery({
    queryKey: ['timeline', shift.id],
    queryFn: () => api<{ events: TimelineEntry[] }>('GET', `/shifts/${shift.id}/timeline`),
  });
  const [note, setNote] = useState('');
  const addNote = useAction(() => api('POST', `/shifts/${shift.id}/notes`, { note }), {
    success: 'Note added.',
    onSuccess: () => setNote(''),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    addNote.mutate();
  }

  return (
    <Panel className="p-5">
      <h2 className="font-bold">History</h2>
      <p className="mb-4 text-sm text-muted">Everything that happened to this shift, oldest first. Entries can't be edited or removed.</p>
      {timeline.isPending ? (
        <Loading />
      ) : timeline.isError ? (
        <ErrorBanner error={timeline.error} />
      ) : timeline.data.events.length === 0 ? (
        <EmptyState title="No history yet" />
      ) : (
        <ol className="relative ml-1.5 border-l border-rule">
          {timeline.data.events.map((event) => (
            <li key={event.id} className="relative mb-4 pl-5 last:mb-0">
              <span className="absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-rule-strong" />
              <p className="text-sm">
                <TimelineSentence event={event} />
              </p>
              {event.note && (
                <blockquote className="mt-1 whitespace-pre-wrap rounded-md bg-paper px-3 py-2 text-sm text-ink-soft">
                  {event.note}
                </blockquote>
              )}
              <p className="text-xs text-muted">{formatTimestamp(event.createdAt, orgTimezone)}</p>
            </li>
          ))}
        </ol>
      )}

      {isCoordinator && !shift.deletedAt && !shift.programArchived && (
        <form onSubmit={submit} className="mt-5 space-y-2 border-t border-rule pt-4">
          <Field label="Add a note" hint="Notes are visible to the program's members and are permanent.">
            <Textarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button type="submit" busy={addNote.isPending} disabled={!note.trim()}>
            Add note
          </Button>
        </form>
      )}
    </Panel>
  );
}

const FIELD_LABEL: Record<string, string> = {
  date: 'date',
  startTime: 'start time',
  durationMinutes: 'duration',
  location: 'location',
  requiredHeadcount: 'volunteers needed',
};

function TimelineSentence({ event }: { event: TimelineEntry }) {
  const actor = <strong>{event.actor.name}</strong>;
  const volunteer = <strong>{event.volunteer?.name}</strong>;
  const self = event.volunteer?.id === event.actor.id;
  switch (event.type) {
    case 'created':
      return <>{actor} created the shift{event.details?.source === 'recurring' ? ' from a weekly pattern' : ''}.</>;
    case 'updated': {
      const changes = (event.details?.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      const described = Object.entries(changes)
        .map(([field, change]) => `${FIELD_LABEL[field] ?? field} from ${String(change.from)} to ${String(change.to)}`)
        .join('; ');
      return <>{actor} changed the {described}.</>;
    }
    case 'state_changed':
      return (
        <>
          Fill state changed from{' '}
          <span className="inline-flex items-center gap-1 font-semibold">
            <StateDot state={event.fromState!} />
            {STATE_LABEL[event.fromState!]}
          </span>{' '}
          to{' '}
          <span className="inline-flex items-center gap-1 font-semibold">
            <StateDot state={event.toState!} />
            {STATE_LABEL[event.toState!]}
          </span>
          .
        </>
      );
    case 'signup_created':
      return self ? <>{volunteer} signed up.</> : <>{actor} signed up {volunteer}.</>;
    case 'signup_cancelled': {
      const reason =
        event.details?.reason === 'removed_from_program'
          ? ' (removed from the program)'
          : event.details?.reason === 'shift_deleted'
            ? ' (shift deleted)'
            : '';
      return self ? (
        <>{volunteer} cancelled their signup.</>
      ) : (
        <>
          {actor} cancelled {volunteer}'s signup{reason}.
        </>
      );
    }
    case 'note':
      return <>{actor} added a note:</>;
    case 'alert_dismissed':
      return <>{actor} dismissed the understaffing alert.</>;
    case 'deleted':
      return <>{actor} deleted the shift.</>;
  }
}
