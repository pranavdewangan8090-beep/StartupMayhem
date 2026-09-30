import { useState } from 'react';
import { useAuth } from '../../lib/AuthContext.jsx';
import ECellLogo from '../../components/ECellLogo.jsx';
import TeamResourcePanel from '../../components/TeamResourcePanel.jsx';
import ControlRoomTab from './ControlRoomTab.jsx';
import LeaderboardTab from './LeaderboardTab.jsx';
import TeamManagementTab from './TeamManagementTab.jsx';

const TABS = [
  { key: 'control', label: 'Control Room' },
  { key: 'teams', label: 'Teams' },
  { key: 'scores', label: 'Leaderboard' },
  { key: 'manage', label: 'Manage Teams' },
];

export default function SuperAdminApp() {
  const [tab, setTab] = useState('control');
  const { logout } = useAuth();
  const active = TABS.find((t) => t.key === tab);

  return (
    <div className="super-shell">
      <aside className="super-sidebar">
        <div className="super-brand"><ECellLogo size={28} /> Startup<span>Mayhem</span></div>
        <div className="super-brand-sub">Super Admin</div>
        <nav className="super-nav">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
        <button className="logout-btn super-logout" onClick={logout}>Log out</button>
      </aside>
      <main className="super-main">
        <div className="super-main-header">
          <h1>{active?.label}</h1>
        </div>
        <div className="super-main-body">
          {tab === 'control' && <ControlRoomTab />}
          {tab === 'teams' && <TeamResourcePanel />}
          {tab === 'scores' && <LeaderboardTab />}
          {tab === 'manage' && <TeamManagementTab />}
        </div>
      </main>
    </div>
  );
}
