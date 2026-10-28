import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import type { MyProgram, Program } from '../api/types';
import { useAction } from '../api/useAction';
import { useAuth } from '../auth/AuthContext';
import { Dialog } from '../components/Dialog';
import { ShiftTable, VolunteerShiftAction } from '../components/ShiftTable';
import { Button, EmptyState, ErrorBanner, Field, Input, Loading, PageHeader, Panel, Textarea } from '../components/ui';
import { plural } from '../lib/format';

export function ProgramsPage() {
  const { isCoordinator } = useAuth();
  return isCoordinator ? <CoordinatorPrograms /> : <MyPrograms />;
}

function CoordinatorPrograms() {
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const programs = useQuery({
    queryKey: ['programs', showArchived ? 'archived' : 'active'],
    queryFn: () => api<{ programs: Program[] }>('GET', `/programs?archived=${showArchived}`),
  });
  const create = useAction((input: { name: string; description: string }) => api<{ program: Program }>('POST', '/programs', input), {
    success: 'Program created.',
    onSuccess: ({ program }) => navigate(`/programs/${program.id}`),
  });

  return (
    <>
      <PageHeader
        title="Programs"
        meta="Each program has its own shifts and members."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New program
          </Button>
        }
      />
      <div className="mb-4 flex gap-1" role="tablist">
        {[false, true].map((archived) => (
          <button
            key={String(archived)}
            role="tab"
            aria-selected={showArchived === archived}
            onClick={() => setShowArchived(archived)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
              showArchived === archived ? 'bg-ink text-white' : 'text-ink-soft hover:bg-surface'
            }`}
          >
            {archived ? 'Archived' : 'Active'}
          </button>
        ))}
      </div>

      <Panel>
        {programs.isPending ? (
          <Loading />
        ) : programs.isError ? (
          <div className="p-4">
            <ErrorBanner error={programs.error} />
          </div>
        ) : programs.data.programs.length === 0 ? (
          <EmptyState title={showArchived ? 'No archived programs' : 'No programs yet'}>
            {showArchived ? 'Archived programs keep all their shifts and history.' : 'Create one to start adding shifts.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-rule">
            {programs.data.programs.map((program) => (
              <li key={program.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <Link to={`/programs/${program.id}`} className="font-bold hover:underline">
                    {program.name}
                  </Link>
                  {program.description && <p className="max-w-prose truncate text-sm text-muted">{program.description}</p>}
                </div>
                <p className="text-sm text-ink-soft">
                  {plural(program.memberCount, 'member')}, {plural(program.upcomingShiftCount, 'upcoming shift')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Dialog open={creating} title="New program" onClose={() => setCreating(false)}>
        <ProgramForm submitLabel="Create program" busy={create.isPending} onSubmit={(values) => create.mutate(values)} />
      </Dialog>
    </>
  );
}

export function ProgramForm({
  initial = { name: '', description: '' },
  submitLabel,
  busy,
  onSubmit,
}: {
  initial?: { name: string; description: string };
  submitLabel: string;
  busy: boolean;
  onSubmit: (values: { name: string; description: string }) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ name, description });
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Name">
        <Input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" hint="What volunteers do, where, and anything to bring.">
        <Textarea rows={4} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" busy={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}

/** Goal 5: one list of every program the volunteer belongs to and the shifts within them. */
function MyPrograms() {
  const [includePast, setIncludePast] = useState(false);
  const programs = useQuery({
    queryKey: ['my-programs', includePast],
    queryFn: () => api<{ programs: MyProgram[] }>('GET', `/me/programs?includePast=${includePast}`),
  });

  return (
    <>
      <PageHeader
        title="My programs"
        meta="Every program you belong to, with its shifts."
        actions={
          <label className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
            <input type="checkbox" checked={includePast} onChange={(e) => setIncludePast(e.target.checked)} />
            Include past shifts
          </label>
        }
      />
      {programs.isPending ? (
        <Loading />
      ) : programs.isError ? (
        <ErrorBanner error={programs.error} />
      ) : programs.data.programs.length === 0 ? (
        <Panel>
          <EmptyState title="You're not in any program yet">
            A coordinator adds volunteers to programs. Once you're added, its shifts appear here.
          </EmptyState>
        </Panel>
      ) : (
        <div className="space-y-6">
          {programs.data.programs.map((program) => (
            <Panel key={program.id}>
              <div className="px-5 pt-5">
                <Link to={`/programs/${program.id}`} className="text-lg font-bold hover:underline">
                  {program.name}
                </Link>
                {program.description && <p className="mt-1 max-w-prose text-sm text-muted">{program.description}</p>}
              </div>
              {program.shifts.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">No {includePast ? '' : 'upcoming '}shifts.</p>
              ) : (
                <div className="mt-3">
                  <ShiftTable
                    shifts={program.shifts}
                    showProgram={false}
                    actions={(shift) => <VolunteerShiftAction shift={shift as MyProgram['shifts'][number]} />}
                  />
                </div>
              )}
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
