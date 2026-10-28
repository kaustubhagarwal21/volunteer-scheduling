import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { ApiError } from '../api/client';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-white hover:bg-ink-soft disabled:bg-muted',
  secondary: 'bg-surface text-ink border border-rule-strong hover:bg-paper',
  danger: 'bg-surface text-open border border-open/40 hover:bg-open-tint',
  quiet: 'text-ink-soft hover:bg-rule/60',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; busy?: boolean }) {
  const sizing = size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4';
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${sizing} ${buttonStyles[variant]} ${className}`}
      disabled={disabled || busy}
      {...rest}
    >
      {busy && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />}
      {children}
    </button>
  );
}

const controlStyles =
  'w-full rounded-md border border-rule-strong bg-surface px-3 text-ink placeholder:text-muted/70 disabled:bg-paper';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`h-10 ${controlStyles} ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`h-10 ${controlStyles} ${props.className ?? ''}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`py-2 ${controlStyles} ${props.className ?? ''}`} />;
}

/** A labelled form control with an optional hint. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-ink-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-sm text-muted">{hint}</span>}
    </label>
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-rule bg-surface ${className}`}>{children}</section>;
}

export function PageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {meta && <div className="mt-1 text-muted">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

/** Shows the server's explanation of what went wrong (e.g. why a signup was rejected). */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <p role="alert" className="rounded-md border border-open/30 bg-open-tint px-3 py-2 text-sm text-open">
      {message}
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 text-muted">{children}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="px-6 py-10 text-center text-muted">{label}</p>;
}
