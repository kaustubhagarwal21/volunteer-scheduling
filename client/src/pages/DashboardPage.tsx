import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { Dashboard } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { StateBreakdownBar, WeeklySignupsChart } from '../components/Charts';
import { STATE_LABEL, STATES, StateDot, stateFill } from '../components/ShiftState';
import { ErrorBanner, Loading, PageHeader, Panel } from '../components/ui';
import { formatDate } from '../lib/format';

export function DashboardPage() {
  const { isCoordinator } = useAuth();
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('GET', '/dashboard') });

  if (dashboard.isPending) return <Loading />;
  if (dashboard.isError) return <ErrorBanner error={dashboard.error} />;
  const { headline, weekStart, weekEnd, byState, byProgram, signupsPerWeek } = dashboard.data;

  return (
    <>
      <PageHeader
        title="Dashboard"
        meta={
          <>
            This week runs {formatDate(weekStart)} to {formatDate(weekEnd)}.{' '}
            {!isCoordinator && 'Numbers cover the programs you belong to.'}
          </>
        }
      />

      <section className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rule bg-rule md:grid-cols-4">
        <StatTile label="Shifts this week" value={headline.shiftsThisWeek} />
        <StatTile
          label="Open shifts this week"
          value={headline.openShiftsThisWeek}
          note={`Nobody signed up yet. ${headline.partiallyFilledThisWeek} more partially filled.`}
          link={{ to: '/shifts?state=open', label: 'See open shifts' }}
        />
        <StatTile label="Signups made this week" value={headline.signupsThisWeek} note="Includes any later cancelled." />
        <StatTile label="Shifts closed this week" value={headline.closedThisWeek} />
      </section>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Panel className="p-5">
          <h2 className="font-bold">Signups per week</h2>
          <p className="mb-3 text-sm text-muted">Last eight weeks, by the week each signup was made.</p>
          <WeeklySignupsChart weeks={signupsPerWeek} />
        </Panel>
        <Panel className="p-5">
          <h2 className="font-bold">Shifts by fill state</h2>
          <p className="mb-3 text-sm text-muted">All shifts in active programs, past and upcoming.</p>
          <StateBreakdownBar counts={byState} />
        </Panel>
      </div>

      <Panel>
        <h2 className="px-5 pt-5 font-bold">Shifts by program</h2>
        <div className="overflow-x-auto p-2">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Program</th>
                {STATES.map((state) => (
                  <th key={state} className="px-3 py-2 text-right font-semibold">
                    <span className="inline-flex items-center gap-1.5">
                      <StateDot state={state} />
                      {STATE_LABEL[state]}
                    </span>
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="w-40 px-3 py-2" aria-label="Breakdown" />
              </tr>
            </thead>
            <tbody>
              {byProgram.map((program) => (
                <tr key={program.programId} className="border-t border-rule">
                  <td className="px-3 py-2">
                    <Link to={`/programs/${program.programId}`} className="font-semibold hover:underline">
                      {program.name}
                    </Link>
                  </td>
                  {STATES.map((state) => (
                    <td key={state} className="px-3 py-2 text-right tabular-nums">
                      {program[state]}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{program.total}</td>
                  <td className="px-3 py-2">
                    <div className="flex h-2 gap-[2px]" aria-hidden>
                      {STATES.filter((state) => program[state] > 0).map((state) => (
                        <span
                          key={state}
                          className={`first:rounded-l last:rounded-r ${stateFill[state]}`}
                          style={{ width: `${(program[state] / program.total) * 100}%` }}
                        />
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {byProgram.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted">
                    {isCoordinator ? 'No active programs yet.' : 'You are not a member of any active program yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function StatTile({
  label,
  value,
  note,
  link,
}: {
  label: string;
  value: number;
  note?: string;
  link?: { to: string; label: string };
}) {
  return (
    <div className="bg-surface p-5">
      <p className="text-sm font-semibold text-ink-soft">{label}</p>
      <p className="mt-1 text-4xl font-bold">{value.toLocaleString()}</p>
      {note && <p className="mt-1 text-sm text-muted">{note}</p>}
      {link && (
        <Link to={link.to} className="mt-1 inline-block text-sm font-semibold underline-offset-2 hover:underline">
          {link.label}
        </Link>
      )}
    </div>
  );
}
