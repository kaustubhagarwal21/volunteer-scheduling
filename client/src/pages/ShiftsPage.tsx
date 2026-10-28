import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, toQuery } from '../api/client';
import type { FinderResult, Program, ShiftListItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Pagination } from '../components/Pagination';
import { STATE_LABEL, STATES } from '../components/ShiftState';
import { ShiftTable, VolunteerShiftAction } from '../components/ShiftTable';
import { Button, EmptyState, ErrorBanner, Field, Input, Loading, PageHeader, Panel, Select } from '../components/ui';

const PAGE_SIZE = 20;

/**
 * Goal 6: every shift the viewer can see, searched, filtered, sorted and paginated by the server.
 * The filters live in the URL, so a filtered view can be bookmarked or shared and Back works.
 */
export function ShiftsPage() {
  const { today } = useAuth();
  const [params, setParams] = useSearchParams();

  // An absent dateFrom means "from today"; an explicitly empty one means "any date".
  const filters = {
    q: params.get('q') ?? '',
    programId: params.get('programId') ?? '',
    state: params.get('state') ?? '',
    dateFrom: params.get('dateFrom') ?? today,
    dateTo: params.get('dateTo') ?? '',
    sort: params.get('sort') ?? 'date',
    order: params.get('order') ?? 'asc',
    page: Number(params.get('page') ?? '1'),
  };

  function update(changes: Partial<Record<keyof typeof filters, string>>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === '' && key !== 'dateFrom') next.delete(key);
      else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page'); // any filter change starts again at page 1
    setParams(next, { replace: true });
  }

  // Search as you type, but only ask the server once typing pauses. Deliberately keyed on the
  // typed text alone: re-running on every URL change would restart the timer for no reason.
  const [search, setSearch] = useState(filters.q);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== filters.q) update({ q: search });
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const programs = useQuery({ queryKey: ['programs', 'active'], queryFn: () => api<{ programs: Program[] }>('GET', '/programs') });
  const result = useQuery({
    queryKey: ['shifts', filters],
    queryFn: () => api<FinderResult>('GET', `/shifts${toQuery({ ...filters, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData, // keep showing the last page while the next one loads
  });

  return (
    <>
      <PageHeader title="Shifts" meta="Every shift in the programs you can see. Search covers program names and locations." />

      <Panel className="mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search">
            <Input type="search" placeholder="Program or location" value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <Field label="Program">
            <Select value={filters.programId} onChange={(e) => update({ programId: e.target.value })}>
              <option value="">All programs</option>
              {programs.data?.programs.map((program) => (
                <option key={program.id} value={program.id}>
                  {program.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fill state">
            <Select value={filters.state} onChange={(e) => update({ state: e.target.value })}>
              <option value="">Any state</option>
              {STATES.map((state) => (
                <option key={state} value={state}>
                  {STATE_LABEL[state]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Sort by">
            <div className="flex gap-2">
              <Select value={filters.sort} onChange={(e) => update({ sort: e.target.value })}>
                <option value="date">Date</option>
                <option value="start_time">Start time</option>
                <option value="state">Fill state</option>
              </Select>
              <Select
                aria-label="Sort order"
                className="w-28"
                value={filters.order}
                onChange={(e) => update({ order: e.target.value })}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </Select>
            </div>
          </Field>
          <Field label="From date">
            <Input type="date" value={filters.dateFrom} onChange={(e) => update({ dateFrom: e.target.value })} />
          </Field>
          <Field label="To date">
            <Input type="date" value={filters.dateTo} onChange={(e) => update({ dateTo: e.target.value })} />
          </Field>
          <div className="flex items-end gap-2 sm:col-span-2">
            <Button onClick={() => update({ dateFrom: '' })} disabled={filters.dateFrom === ''}>
              Include past shifts
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setSearch('');
                setParams(new URLSearchParams(), { replace: true });
              }}
            >
              Reset filters
            </Button>
          </div>
        </div>
      </Panel>

      <Panel className={result.isPlaceholderData ? 'opacity-60 transition-opacity' : ''}>
        {result.isPending ? (
          <Loading />
        ) : result.isError ? (
          <div className="p-4">
            <ErrorBanner error={result.error} />
          </div>
        ) : result.data.items.length === 0 ? (
          <EmptyState title="No shifts match these filters">Try another search, or include past shifts.</EmptyState>
        ) : (
          <>
            <ShiftTable
              shifts={result.data.items}
              actions={(shift) => <VolunteerShiftAction shift={shift as ShiftListItem} />}
            />
            <Pagination
              page={result.data.page}
              pageSize={result.data.pageSize}
              total={result.data.total}
              totalPages={result.data.totalPages}
              onPage={(page) => update({ page: String(page) })}
            />
          </>
        )}
      </Panel>
    </>
  );
}
