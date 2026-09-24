import TopBar from '../../components/TopBar.jsx';
import TeamResourcePanel from '../../components/TeamResourcePanel.jsx';

export default function AdminApp() {
  return (
    <div className="app-shell">
      <TopBar title="Admin" />
      <div className="page">
        <TeamResourcePanel />
      </div>
    </div>
  );
}
