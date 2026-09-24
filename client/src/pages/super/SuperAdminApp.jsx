import { useState } from 'react';
import TopBar from '../../components/TopBar.jsx';
import TeamResourcePanel from '../../components/TeamResourcePanel.jsx';
import ControlRoomTab from './ControlRoomTab.jsx';
import ScoresTab from './ScoresTab.jsx';
import TeamManagementTab from './TeamManagementTab.jsx';
import AuditLogTab from './AuditLogTab.jsx';

const TABS = [
  { key: 'control', label: 'Control Room' },
  { key: 'teams', label: 'Teams' },
  { key: 'scores', label: 'Scores' },
  { key: 'manage', label: 'Manage Teams' },
  { key: 'audit', label: 'Audit Log' },
];

export default function SuperAdminApp() {
  const [tab, setTab] = useState('control');

  return (
    <div className="app-shell">
      <TopBar title="Super Admin" />
      <div className="tabbar">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <div className="page">
        {tab === 'control' && <ControlRoomTab />}
        {tab === 'teams' && <TeamResourcePanel />}
        {tab === 'scores' && <ScoresTab />}
        {tab === 'manage' && <TeamManagementTab />}
        {tab === 'audit' && <AuditLogTab />}
      </div>
    </div>
  );
}
