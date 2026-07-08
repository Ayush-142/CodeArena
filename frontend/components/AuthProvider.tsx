'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { AUTH_UNAUTHORIZED_EVENT, getMe, login as apiLogin, logout as apiLogout, register as apiRegister } from '@/lib/api';
import type { AuthUser } from '@/lib/types';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (handle: string, password: string) => Promise<AuthUser>;
  register: (handle: string, email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refetchMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  const refetchMe = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me);
      setStatus('authenticated');
    } catch {
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  useEffect(() => {
    void refetchMe();
  }, [refetchMe]);

  // Fired by lib/api.ts on any 401 that isn't a login/register credential check — treat as
  // session expired. Setting the same state twice if multiple requests 401 at once is a
  // harmless no-op, so no dedup logic is needed here.
  useEffect(() => {
    function handleUnauthorized() {
      setUser(null);
      setStatus('unauthenticated');
    }
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
  }, []);

  const login = useCallback(async (handle: string, password: string) => {
    const me = await apiLogin(handle, password);
    setUser(me);
    setStatus('authenticated');
    return me;
  }, []);

  const register = useCallback(async (handle: string, email: string, password: string) => {
    const me = await apiRegister(handle, email, password);
    setUser(me);
    setStatus('authenticated');
    return me;
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, login, register, logout, refetchMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
