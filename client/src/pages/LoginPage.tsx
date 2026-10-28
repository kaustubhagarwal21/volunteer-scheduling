import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorBanner, Field, Input } from '../components/ui';

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const returnTo = (location.state as { from?: string } | null)?.from ?? '/';
  if (user) return <Navigate to={returnTo} replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in" footer={<>New volunteer? <Link className="font-semibold underline" to="/register">Create an account</Link></>}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email">
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorBanner error={error} />
        <Button type="submit" variant="primary" busy={busy} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}

export function AuthCard({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-lg font-bold">Volunteer Scheduling</p>
        <div className="rounded-lg border border-rule bg-surface p-6">
          <h1 className="mb-5 text-xl font-bold">{title}</h1>
          {children}
        </div>
        <p className="mt-4 text-center text-sm text-muted">{footer}</p>
      </div>
    </main>
  );
}
