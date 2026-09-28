import { useAuth } from '../lib/AuthContext.jsx';
import ECellLogo from './ECellLogo.jsx';

export default function TopBar({ title, right }) {
  const { logout } = useAuth();
  return (
    <div className="topbar">
      <div className="brand">
        <ECellLogo size={26} />
        Startup<span>Mayhem</span>{title ? ` · ${title}` : ''}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {right}
        <button className="logout-btn" onClick={logout}>Log out</button>
      </div>
    </div>
  );
}
