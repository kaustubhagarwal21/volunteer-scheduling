import { createBrowserRouter, Link, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { EmptyState, Loading } from './components/ui';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';

/** Everything except sign-in/registration requires a session; the server enforces it regardless. */
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
          { index: true, element: <Placeholder name="Dashboard" /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);

function Placeholder({ name }: { name: string }) {
  return <EmptyState title={name}>Coming next.</EmptyState>;
}

export function App() {
  return <RouterProvider router={router} />;
}
