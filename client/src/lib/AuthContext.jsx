import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase, getToken, setToken, call } from './supabase.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading, null = logged out

  // there's no server session to ask "who am I" — instead, re-validate the
  // JWT already sitting in localStorage against the DB (checks session_version
  // and is_active too, so a stale/replaced token is caught immediately)
  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      return;
    }
    try {
      const rows = await call(supabase.rpc('fn_auth_user'));
      const me = rows?.[0];
      if (!me) {
        setToken(null);
        setUser(null);
      } else {
        setUser({ role: me.app_role, teamId: me.team_id });
      }
    } catch {
      setToken(null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (loginId, password, role) => {
    const result = await call(supabase.rpc('fn_login', { p_role: role, p_login_id: loginId, p_password: password }));
    setToken(result.token);
    const me = { role: result.role, teamId: result.teamId };
    setUser(me);
    return me;
  }, []);

  const logout = useCallback(async () => {
    setToken(null);
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, login, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
