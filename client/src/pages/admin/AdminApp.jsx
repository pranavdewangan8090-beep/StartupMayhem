import { useState } from 'react';
import TopBar from '../../components/TopBar.jsx';
import TradePanel from './TradePanel.jsx';
import CrisesTab from './CrisesTab.jsx';

const TABS = [
  { key: 'trade', label: 'Trade Cards' },
  { key: 'crises', label: 'Crises' },
];

export default function AdminApp() {
  const [tab, setTab] = useState('trade');
  return (
    <div className="app-shell">
      <TopBar title="Admin" />
      <div className="tabbar">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="page">
        {tab === 'trade' && <TradePanel />}
        {tab === 'crises' && <CrisesTab />}
      </div>
    </div>
  );
}
