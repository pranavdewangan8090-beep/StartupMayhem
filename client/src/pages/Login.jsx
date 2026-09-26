import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.jsx';
import { ApiError } from '../lib/api.js';

const ROLES = [
  { key: 'player', label: 'Team' },
  { key: 'admin', label: 'Admin' },
  { key: 'super_admin', label: 'Super Admin' },
];

export default function Login() {
  const [role, setRole] = useState('player');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(loginId.trim(), password, role);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log in. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-title">Startup Mayhem</div>
        <p className="login-sub">Log in to your team, admin or super admin account.</p>

        <div className="card-surface">
          <div className="role-switch">
            {ROLES.map((r) => (
              <button
                key={r.key}
                type="button"
                className={role === r.key ? 'active' : ''}
                onClick={() => setRole(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>

          <form onSubmit={onSubmit}>
            <div className="field">
              <label>{role === 'player' ? 'Team ID' : `${role === 'admin' ? 'Admin' : 'Super Admin'} ID`}</label>
              <input
                autoFocus
                autoCapitalize="characters"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                placeholder={role === 'player' ? 'T01' : '1'}
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary btn-block" disabled={busy} type="submit">
              {busy ? 'Logging in…' : 'Log In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
