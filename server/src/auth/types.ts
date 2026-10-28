export type Role = 'coordinator' | 'volunteer';

/** The signed-in user, loaded from the session on every request. */
export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

// Lets route handlers use req.user with this type (set by requireAuth).
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
