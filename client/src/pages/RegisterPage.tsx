import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorBanner, Field, Input } from '../components/ui';
import { AuthCard } from './LoginPage';

export function RegisterPage() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(name, email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Create a volunteer account"
      footer={<>Already have an account? <Link className="font-semibold underline" to="/login">Sign in</Link></>}
    >
      <p className="mb-4 text-sm text-muted">
        After you sign up, a coordinator adds you to the programs you help with. Their shifts then appear here.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Full name">
          <Input autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorBanner error={error} />
        <Button type="submit" variant="primary" busy={busy} className="w-full">
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}
