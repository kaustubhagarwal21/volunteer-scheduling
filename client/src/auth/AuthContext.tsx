import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { User } from '../api/types';

interface MeResponse {
  user: User;
  orgTimezone: string;
}

interface AuthState {
  user: User | null;
  isCoordinator: boolean;
  /** IANA zone used to display absolute timestamps such as "signed up at". */
  orgTimezone: string;
  isLoading: boolean;
  login(email: string, password: string): Promise<void>;
  register(name: string, email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

export const ME_QUERY_KEY = ['me'];

const AuthContext = createContext<AuthState | null>(null);

async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await api<MeResponse>('GET', '/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMe, staleTime: Infinity });

  /** Forget everything cached for the previous user, then load the new identity. */
  async function switchUser() {
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_QUERY_KEY[0] });
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }

  const user = me.data?.user ?? null;
  const value: AuthState = {
    user,
    isCoordinator: user?.role === 'coordinator',
    orgTimezone: me.data?.orgTimezone ?? 'UTC',
    isLoading: me.isPending,
    async login(email, password) {
      await api('POST', '/auth/login', { email, password });
      await switchUser();
    },
    async register(name, email, password) {
      await api('POST', '/auth/register', { name, email, password });
      await switchUser();
    },
    async logout() {
      await api('POST', '/auth/logout');
      queryClient.setQueryData(ME_QUERY_KEY, null);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_QUERY_KEY[0] });
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
