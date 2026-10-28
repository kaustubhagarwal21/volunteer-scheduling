/** Error returned by the API: `{ error: { code, message, details? } }` with a non-2xx status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * The one place the browser talks to the server. The API is on the same origin (Vite proxies /api
 * in development; Express serves both in production), so the session cookie is sent automatically.
 */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    // The server requires this on every state-changing call (a CSRF safeguard), body or not.
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      res.status,
      error?.code ?? 'HTTP_ERROR',
      error?.message ?? `Request failed (${res.status})`,
      error?.details,
    );
  }
  return payload as T;
}

/** Builds a query string from the defined, non-empty values only. */
export function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
