import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { supabase, getToken, setToken, call, throwIfLoginError, SESSION_INVALID_EVENT } from './supabase.js';

const AuthContext = createContext(null);

const SESSION_ENDED_NOTICE =
  'You were logged out — this account was logged in on another device, or deactivated. Log in again to continue.';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading, null = logged out
  // shown on the login screen after a session is ended from elsewhere, so a
  // player knows why they landed there instead of assuming the app broke
  const [notice, setNotice] = useState('');
  const userRef = useRef(user);
  userRef.current = user;

  // there's no server session to ask "who am I" — instead, re-validate the
  // JWT already sitting in localStorage against the DB (checks session_version
  // and is_active too, so a stale/replaced token is caught immediately)
  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      return;
    }
    // called directly (not through call()) so a failure here can't re-fire
    // SESSION_INVALID_EVENT and loop back into refresh()
    const { data, error } = await supabase.rpc('fn_auth_user');
    // a network failure isn't proof the session is gone — stay logged in and
    // let the next call try again; only an auth rejection ends the session
    if (error && error.code !== 'PGRST301' && !/jwt/i.test(error.message || '')) {
      if (userRef.current === undefined) setUser(null);
      return;
    }
    const me = error ? null : data?.[0];
    if (!me) {
      setToken(null);
      if (userRef.current) setNotice(SESSION_ENDED_NOTICE);
      setUser(null);
    } else {
      setUser({ role: me.app_role, teamId: me.team_id });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    window.addEventListener(SESSION_INVALID_EVENT, refresh);
    return () => window.removeEventListener(SESSION_INVALID_EVENT, refresh);
  }, [refresh]);

  const login = useCallback(async (loginId, password, role) => {
    const result = throwIfLoginError(await call(supabase.rpc('fn_login', { p_role: role, p_login_id: loginId, p_password: password })));
    setToken(result.token);
    const me = { role: result.role, teamId: result.teamId };
    setNotice('');
    setUser(me);
    return me;
  }, []);

  const logout = useCallback(async () => {
    setToken(null);
    setNotice('');
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, login, logout, refresh, notice }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
