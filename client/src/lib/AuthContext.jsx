import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, ApiError } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading, null = logged out

  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/auth/me');
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (loginId, password, role) => {
    const result = await api.post('/auth/login', { loginId, password, role });
    setUser(result);
    return result;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore
    }
    setUser(null);
  }, []);

  // if any request comes back 401 SESSION_REPLACED, drop straight to login with a clear reason
  useEffect(() => {
    function onUnhandled(e) {
      if (e?.reason instanceof ApiError && e.reason.code === 'SESSION_REPLACED') {
        setUser(null);
      }
    }
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => window.removeEventListener('unhandledrejection', onUnhandled);
  }, []);

  return <AuthContext.Provider value={{ user, login, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
