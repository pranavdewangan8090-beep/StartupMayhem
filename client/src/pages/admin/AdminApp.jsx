import TopBar from '../../components/TopBar.jsx';
import TradePanel from './TradePanel.jsx';

export default function AdminApp() {
  return (
    <div className="app-shell">
      <TopBar title="Admin" />
      <div className="page">
        <TradePanel />
      </div>
    </div>
  );
}
