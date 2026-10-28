/**
 * An error that carries the HTTP status and a stable machine-readable code.
 * Services throw these; the error handler turns them into JSON responses.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'VALIDATION_ERROR', message, details);

export const unauthenticated = (message = 'Please sign in.') => new HttpError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message: string) => new HttpError(403, 'FORBIDDEN', message);

export const notFound = (what: string, hint?: string) =>
  new HttpError(404, 'NOT_FOUND', hint ? `${what} not found. ${hint}` : `${what} not found.`);

/** A request that is well-formed but breaks a business rule, e.g. signing up for a Filled shift. */
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
