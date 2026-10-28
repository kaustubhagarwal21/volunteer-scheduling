import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { api, toQuery } from '../api/client';
import type { FinderResult, GenerateResult, Member, Program, ShiftListItem, VolunteerOption } from '../api/types';
import { useAction } from '../api/useAction';
import { useAuth } from '../auth/AuthContext';
import { Dialog } from '../components/Dialog';
import { Pagination } from '../components/Pagination';
import { ShiftForm } from '../components/ShiftForm';
import { ShiftTable, VolunteerShiftAction } from '../components/ShiftTable';
import { Button, EmptyState, ErrorBanner, Field, Input, Loading, PageHeader, Panel, Select } from '../components/ui';
import { addMinutes, formatDate, plural } from '../lib/format';
import { ProgramForm } from './ProgramsPage';

export function ProgramDetailPage() {
  const programId = Number(useParams().id);
  const { isCoordinator } = useAuth();
  const [editing, setEditing] = useState(false);
  const program = useQuery({
    queryKey: ['program', programId],
    queryFn: () => api<{ program: Program }>('GET', `/programs/${programId}`),
  });
  const update = useAction((values: { name: string; description: string }) => api('PATCH', `/programs/${programId}`, values), {
    success: 'Program updated.',
    onSuccess: () => setEditing(false),
  });
  const archive = useAction(() => api('POST', `/programs/${programId}/archive`), { success: 'Program archived.' });
  const restore = useAction(() => api('POST', `/programs/${programId}/restore`), { success: 'Program restored.' });

  if (program.isPending) return <Loading />;
  if (program.isError) return <ErrorBanner error={program.error} />;
  const p = program.data.program;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {p.name}
            {p.archived && (
              <span className="rounded-full border border-rule px-2 py-0.5 text-xs font-semibold text-muted">Archived</span>
            )}
          </span>
        }
        meta={<span className="block max-w-prose whitespace-pre-wrap">{p.description || 'No description.'}</span>}
        actions={
          isCoordinator && (
            <>
              <Button onClick={() => setEditing(true)}>Edit</Button>
              <a
                href={`/api/programs/${programId}/roster.csv`}
                download
                className="inline-flex h-10 items-center rounded-md border border-rule-strong bg-surface px-4 font-medium hover:bg-paper"
              >
                Export roster (CSV)
              </a>
              {p.archived ? (
                <Button variant="primary" busy={restore.isPending} onClick={() => restore.mutate()}>
                  Restore program
                </Button>
              ) : (
                <Button
                  variant="danger"
                  busy={archive.isPending}
                  onClick={() => {
                    const message = `Archive ${p.name}? It disappears from everyday views; its shifts and history are kept and it can be restored.`;
                    if (window.confirm(message)) archive.mutate();
                  }}
                >
                  Archive
                </Button>
              )}
            </>
          )
        }
      />
      {p.archived && (
        <p className="mb-6 rounded-md border border-rule bg-surface px-4 py-3 text-sm text-ink-soft">
          This program is archived: hidden from everyday views, and its shifts, signups and members can't change until it's
          restored. Its name and description can still be edited.
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <ProgramShifts program={p} />
        {isCoordinator && <Members program={p} />}
      </div>

      <Dialog open={editing} title="Edit program" onClose={() => setEditing(false)}>
        <ProgramForm initial={p} submitLabel="Save changes" busy={update.isPending} onSubmit={(values) => update.mutate(values)} />
      </Dialog>
    </>
  );
}

type ShiftView = 'upcoming' | 'past' | 'deleted';

function ProgramShifts({ program }: { program: Program }) {
  const { isCoordinator, today } = useAuth();
  const [view, setView] = useState<ShiftView>('upcoming');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<'add' | 'generate' | null>(null);

  // "Opening a program shows its shifts": the same server-side finder, scoped to this program.
  const query = {
    programId: program.id,
    page,
    pageSize: 15,
    ...(view === 'upcoming' && { dateFrom: today }),
    ...(view === 'past' && { dateTo: today, order: 'desc' }),
    ...(view === 'deleted' && { deleted: 'only' }),
  };
  const shifts = useQuery({
    queryKey: ['shifts', query],
    queryFn: () => api<FinderResult>('GET', `/shifts${toQuery(query)}`),
    placeholderData: keepPreviousData,
  });

  const add = useAction((values: object) => api('POST', `/programs/${program.id}/shifts`, values), {
    success: 'Shift added.',
    onSuccess: () => setDialog(null),
  });

  const views: ShiftView[] = isCoordinator ? ['upcoming', 'past', 'deleted'] : ['upcoming', 'past'];
  const canEdit = isCoordinator && !program.archived;

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div className="flex gap-1" role="tablist">
          {views.map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => {
                setView(v);
                setPage(1);
              }}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold capitalize ${
                view === v ? 'bg-ink text-white' : 'text-ink-soft hover:bg-paper'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setDialog('generate')}>
              Repeat weekly…
            </Button>
            <Button size="sm" variant="primary" onClick={() => setDialog('add')}>
              Add shift
            </Button>
          </div>
        )}
      </div>

      <div className={`mt-3 ${shifts.isPlaceholderData ? 'opacity-60' : ''}`}>
        {shifts.isPending ? (
          <Loading />
        ) : shifts.isError ? (
          <div className="p-4">
            <ErrorBanner error={shifts.error} />
          </div>
        ) : shifts.data.items.length === 0 ? (
          <EmptyState title={`No ${view} shifts`}>
            {view === 'upcoming' && canEdit && 'Add one, or repeat a weekly pattern.'}
            {view === 'deleted' && 'Deleted shifts stay here so their history can still be read.'}
          </EmptyState>
        ) : (
          <>
            <ShiftTable
              shifts={shifts.data.items}
              showProgram={false}
              actions={(shift) => <VolunteerShiftAction shift={shift as ShiftListItem} />}
            />
            <Pagination
              page={shifts.data.page}
              pageSize={shifts.data.pageSize}
              total={shifts.data.total}
              totalPages={shifts.data.totalPages}
              onPage={setPage}
            />
          </>
        )}
      </div>

      <Dialog open={dialog === 'add'} title="Add a shift" onClose={() => setDialog(null)}>
        <ShiftForm
          initial={{ date: today, startTime: '09:00', durationMinutes: 120, location: '', requiredHeadcount: 4 }}
          submitLabel="Add shift"
          busy={add.isPending}
          onSubmit={(values) => add.mutate(values)}
        />
      </Dialog>
      <Dialog open={dialog === 'generate'} title="Repeat a weekly pattern" onClose={() => setDialog(null)}>
        <GenerateForm programId={program.id} />
      </Dialog>
    </Panel>
  );
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Goal 7: bulk-create shifts from a weekly pattern, then show exactly what happened. */
function GenerateForm({ programId }: { programId: number }) {
  const { today } = useAuth();
  const [form, setForm] = useState({
    startDate: today,
    endDate: '',
    dayOfWeek: 6,
    startTime: '09:00',
    durationMinutes: 180,
    location: '',
    requiredHeadcount: 4,
  });
  const [holiday, setHoliday] = useState('');
  const [excludedDates, setExcludedDates] = useState<string[]>([]);
  const [report, setReport] = useState<GenerateResult | null>(null);
  const generate = useAction(
    () => api<GenerateResult>('POST', `/programs/${programId}/shifts/generate`, { ...form, excludedDates }),
    { success: (result) => `${plural(result.created.length, 'shift')} created.`, onSuccess: setReport },
  );
  const set = (key: keyof typeof form, value: string | number) => setForm((current) => ({ ...current, [key]: value }));

  if (report) return <GenerateReport report={report} onAgain={() => setReport(null)} />;

  function submit(event: FormEvent) {
    event.preventDefault();
    generate.mutate();
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="From">
        <Input type="date" required value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
      </Field>
      <Field label="Until (inclusive)">
        <Input type="date" required value={form.endDate} onChange={(e) => set('endDate', e.target.value)} />
      </Field>
      <Field label="Every">
        <Select value={form.dayOfWeek} onChange={(e) => set('dayOfWeek', Number(e.target.value))}>
          {WEEKDAYS.map((day, index) => (
            <option key={day} value={index}>
              {day}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Start time" hint={`Ends at ${addMinutes(form.startTime, form.durationMinutes || 0)}`}>
        <Input type="time" required value={form.startTime} onChange={(e) => set('startTime', e.target.value)} />
      </Field>
      <Field label="Duration (minutes)">
        <Input
          type="number"
          required
          min={15}
          max={1440}
          step={15}
          value={form.durationMinutes}
          onChange={(e) => set('durationMinutes', Number(e.target.value))}
        />
      </Field>
      <Field label="Volunteers needed">
        <Input
          type="number"
          required
          min={1}
          max={500}
          value={form.requiredHeadcount}
          onChange={(e) => set('requiredHeadcount', Number(e.target.value))}
        />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Location">
          <Input required maxLength={200} value={form.location} onChange={(e) => set('location', e.target.value)} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <span className="mb-1 block text-sm font-semibold text-ink-soft">Skip these dates (holidays)</span>
        <div className="flex gap-2">
          <Input type="date" value={holiday} onChange={(e) => setHoliday(e.target.value)} aria-label="Holiday date" />
          <Button
            onClick={() => {
              if (holiday && !excludedDates.includes(holiday)) setExcludedDates([...excludedDates, holiday].sort());
              setHoliday('');
            }}
          >
            Add
          </Button>
        </div>
        {excludedDates.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-2">
            {excludedDates.map((date) => (
              <li key={date} className="flex items-center gap-1 rounded-full border border-rule px-2 py-0.5 text-sm">
                {formatDate(date)}
                <button
                  type="button"
                  aria-label={`Remove ${date}`}
                  className="px-1 text-muted hover:text-ink"
                  onClick={() => setExcludedDates(excludedDates.filter((d) => d !== date))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" busy={generate.isPending}>
          Create shifts
        </Button>
      </div>
    </form>
  );
}

function GenerateReport({ report, onAgain }: { report: GenerateResult; onAgain: () => void }) {
  const reason = { holiday: 'excluded as a holiday', already_exists: 'a shift already exists at that date and time' };
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h3 className="font-bold">Created ({report.created.length})</h3>
        {report.created.length === 0 ? (
          <p className="text-muted">No new shifts.</p>
        ) : (
          <ul className="mt-1 columns-2">
            {report.created.map((shift) => (
              <li key={shift.id}>{formatDate(shift.date)}</li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="font-bold">Skipped ({report.skipped.length})</h3>
        {report.skipped.length === 0 ? (
          <p className="text-muted">Nothing was skipped.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {report.skipped.map((skip) => (
              <li key={skip.date}>
                {formatDate(skip.date)}: {reason[skip.reason]}
              </li>
            ))}
          </ul>
        )}
      </div>
      {report.unusedExclusions.length > 0 && (
        <p className="rounded-md bg-paper px-3 py-2 text-ink-soft">
          These excluded dates weren't on the chosen weekday within the range, so they had no effect:{' '}
          {report.unusedExclusions.map(formatDate).join(', ')}.
        </p>
      )}
      <Button onClick={onAgain}>Repeat another pattern</Button>
    </div>
  );
}

function Members({ program }: { program: Program }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const members = useQuery({
    queryKey: ['members', program.id],
    queryFn: () => api<{ members: Member[] }>('GET', `/programs/${program.id}/members`),
  });
  const candidates = useQuery({
    queryKey: ['volunteers', program.id, search],
    queryFn: () =>
      api<{ volunteers: VolunteerOption[] }>('GET', `/users/volunteers${toQuery({ q: search, excludeProgramId: program.id })}`),
    enabled: !program.archived,
  });
  const add = useAction(() => api('POST', `/programs/${program.id}/members`, { userId: Number(selected) }), {
    success: 'Member added.',
    onSuccess: () => setSelected(''),
  });
  const remove = useAction((userId: number) => api<{ cancelledSignups: number }>('DELETE', `/programs/${program.id}/members/${userId}`), {
    success: (result) =>
      `Member removed${result.cancelledSignups ? `; ${plural(result.cancelledSignups, 'upcoming signup')} cancelled` : ''}.`,
  });

  return (
    <Panel className="h-fit p-5">
      <h2 className="font-bold">Members</h2>
      <p className="mb-3 text-sm text-muted">Only members can sign up for this program's shifts.</p>
      {members.isPending ? (
        <Loading />
      ) : members.isError ? (
        <ErrorBanner error={members.error} />
      ) : members.data.members.length === 0 ? (
        <p className="text-sm text-muted">No members yet.</p>
      ) : (
        <ul className="mb-4 divide-y divide-rule">
          {members.data.members.map((member) => (
            <li key={member.id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate font-semibold">{member.name}</p>
                <p className="truncate text-xs text-muted">{member.email}</p>
                {member.upcomingSignups > 0 && (
                  <p className="text-xs text-muted">{plural(member.upcomingSignups, 'upcoming signup')}</p>
                )}
              </div>
              {!program.archived && (
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    const note = member.upcomingSignups
                      ? ` Their ${plural(member.upcomingSignups, 'upcoming signup')} in this program will be cancelled.`
                      : '';
                    if (window.confirm(`Remove ${member.name} from ${program.name}?${note}`)) remove.mutate(member.id);
                  }}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!program.archived && (
        <form
          className="space-y-2 border-t border-rule pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <Field label="Add a volunteer">
            <Input type="search" placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <Select aria-label="Volunteer to add" required value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">{candidates.data?.volunteers.length ? 'Choose…' : 'No matching volunteers'}</option>
            {candidates.data?.volunteers.map((volunteer) => (
              <option key={volunteer.id} value={volunteer.id}>
                {volunteer.name} ({volunteer.email})
              </option>
            ))}
          </Select>
          <Button type="submit" variant="primary" busy={add.isPending} disabled={!selected}>
            Add member
          </Button>
        </form>
      )}
    </Panel>
  );
}
