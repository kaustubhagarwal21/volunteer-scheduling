import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate, type NavLinkProps } from 'react-router';
import { api } from '../api/client';
import type { AlertsResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Button } from './ui';

export const ALERTS_QUERY_KEY = ['alerts'];

export function Layout() {
  const { user, isCoordinator, logout } = useAuth();
  const navigate = useNavigate();

  // The badge is a live count from the server, refreshed every minute and after every change
  // made in the app (useAction refetches all queries on success).
  const alerts = useQuery({
    queryKey: ALERTS_QUERY_KEY,
    queryFn: () => api<AlertsResponse>('GET', '/alerts'),
    refetchInterval: 60_000,
  });
  const alertCount = alerts.data?.count ?? 0;

  async function signOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2 font-bold">
            <img src="/favicon.svg" alt="" className="size-6" />
            Volunteer Scheduling
          </NavLink>
          <nav className="flex flex-wrap gap-1" aria-label="Main">
            <NavItem to="/" end>
              Dashboard
            </NavItem>
            <NavItem to="/shifts">Shifts</NavItem>
            <NavItem to="/programs">{isCoordinator ? 'Programs' : 'My programs'}</NavItem>
            <NavItem to="/alerts">
              Alerts
              {alertCount > 0 && (
                <span
                  className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-xs font-bold text-white"
                  aria-label={`${alertCount} understaffed shifts`}
                >
                  {alertCount}
                </span>
              )}
            </NavItem>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span>
              {user?.name} <span className="text-muted">({isCoordinator ? 'coordinator' : 'volunteer'})</span>
            </span>
            <Button size="sm" variant="quiet" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

function NavItem(props: NavLinkProps) {
  return (
    <NavLink
      {...props}
      className={({ isActive }) =>
        `inline-flex items-center rounded-md px-3 py-1.5 text-sm font-semibold ${
          isActive ? 'bg-ink text-white' : 'text-ink-soft hover:bg-paper'
        }`
      }
    />
  );
}
