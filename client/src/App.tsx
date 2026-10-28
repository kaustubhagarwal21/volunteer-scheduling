import { createBrowserRouter, Link, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { EmptyState, Loading } from './components/ui';
import { AlertsPage } from './pages/AlertsPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { ProgramDetailPage } from './pages/ProgramDetailPage';
import { ProgramsPage } from './pages/ProgramsPage';
import { RegisterPage } from './pages/RegisterPage';
import { ShiftDetailPage } from './pages/ShiftDetailPage';
import { ShiftsPage } from './pages/ShiftsPage';

/**
 * Everything except sign-in and registration needs a session. This only decides what to render:
 * the server enforces sign-in and roles on every request regardless.
 */
function RequireAuth() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

function NotFound() {
  return (
    <EmptyState title="Page not found">
      <Link to="/" className="underline">
        Back to the dashboard
      </Link>
    </EmptyState>
  );
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'shifts', element: <ShiftsPage /> },
          { path: 'shifts/:id', element: <ShiftDetailPage /> },
          { path: 'programs', element: <ProgramsPage /> },
          { path: 'programs/:id', element: <ProgramDetailPage /> },
          { path: 'alerts', element: <AlertsPage /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
