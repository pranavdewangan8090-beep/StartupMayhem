import { useState } from 'react';
import TopBar from '../../components/TopBar.jsx';
import { useGameState } from '../../hooks/usePoll.js';
import DashboardTab from './DashboardTab.jsx';
import CardsTab from './CardsTab.jsx';
import ActionCardsTab from './ActionCardsTab.jsx';
import MarketTab from './MarketTab.jsx';

const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'cards', label: 'My Cards' },
  { key: 'action', label: 'Action Cards' },
  { key: 'market', label: 'Marketplace' },
];

export default function PlayerApp() {
  const [tab, setTab] = useState('dashboard');
  const { state, refreshNow } = useGameState(4000);

  const badge = (key) => {
    if (key === 'dashboard' && state?.unread_notifications > 0) return state.unread_notifications;
    if (key === 'action' && (state?.pending_deal_offers_in > 0)) return state.pending_deal_offers_in;
    if (key === 'market' && state?.pending_trade_offers_in > 0) return state.pending_trade_offers_in;
    return 0;
  };

  return (
    <div className="app-shell">
      <TopBar />
      <div className="tabbar">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}{badge(t.key) > 0 ? ` •${badge(t.key)}` : ''}
          </button>
        ))}
      </div>
      <div className="page">
        {tab === 'dashboard' && <DashboardTab gameState={state} />}
        {tab === 'cards' && <CardsTab gameState={state} />}
        {tab === 'action' && <ActionCardsTab gameState={state} onChanged={refreshNow} />}
        {tab === 'market' && <MarketTab gameState={state} onChanged={refreshNow} />}
      </div>
    </div>
  );
}
