import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AlertsResponse, Shift, ShiftListItem } from '../api/types';
import { useAction } from '../api/useAction';
import { useAuth } from '../auth/AuthContext';
import { ALERTS_QUERY_KEY } from '../components/Layout';
import { ShiftTable, VolunteerShiftAction } from '../components/ShiftTable';
import { Button, EmptyState, ErrorBanner, Loading, PageHeader, Panel } from '../components/ui';

/**
 * Goal 10: shifts dated today or in the next three days that are still Open or Partially filled.
 * Everyone sees the alerts for their programs; coordinators can dismiss them. A dismissed alert
 * comes back if a cancellation later drops the shift out of Filled.
 */
export function AlertsPage() {
  const { isCoordinator } = useAuth();
  const alerts = useQuery({ queryKey: ALERTS_QUERY_KEY, queryFn: () => api<AlertsResponse>('GET', '/alerts') });

  if (alerts.isPending) return <Loading />;
  if (alerts.isError) return <ErrorBanner error={alerts.error} />;
  const { alerts: active, dismissed } = alerts.data;

  return (
    <>
      <PageHeader
        title="Understaffed shifts"
        meta="Shifts today or in the next three days that still need volunteers and haven't started."
      />
      <Panel className="mb-6">
        {active.length === 0 ? (
          <EmptyState title="Every upcoming shift is covered">Nothing in the next three days needs more volunteers.</EmptyState>
        ) : (
          <ShiftTable
            shifts={active}
            actions={(shift) =>
              isCoordinator ? <DismissButton shift={shift} /> : <VolunteerShiftAction shift={shift as ShiftListItem} />
            }
          />
        )}
      </Panel>

      {isCoordinator && dismissed.length > 0 && (
        <Panel>
          <div className="px-5 pt-5">
            <h2 className="font-bold">Dismissed ({dismissed.length})</h2>
            <p className="text-sm text-muted">
              Still understaffed, but hidden from the badge. One comes back if a cancellation drops its shift out of Filled.
            </p>
          </div>
          <div className="mt-3">
            <ShiftTable shifts={dismissed} />
          </div>
        </Panel>
      )}
    </>
  );
}

function DismissButton({ shift }: { shift: Shift }) {
  const dismiss = useAction(() => api('POST', `/alerts/${shift.id}/dismiss`), { success: 'Alert dismissed.' });
  return (
    <Button size="sm" variant="quiet" busy={dismiss.isPending} onClick={() => dismiss.mutate()}>
      Dismiss
    </Button>
  );
}
