import { useAuth } from '../lib/AuthContext.jsx';

export default function TopBar({ title, right }) {
  const { logout } = useAuth();
  return (
    <div className="topbar">
      <div className="brand">🚀 Startup<span>Mayhem</span>{title ? ` · ${title}` : ''}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {right}
        <button className="logout-btn" onClick={logout}>Log out</button>
      </div>
    </div>
  );
}
