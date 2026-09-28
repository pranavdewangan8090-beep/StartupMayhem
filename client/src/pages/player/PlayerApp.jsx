import { useEffect, useState } from 'react';
import TopBar from '../../components/TopBar.jsx';
import MayhemReveal from '../../components/MayhemReveal.jsx';
import { useAuth } from '../../lib/AuthContext.jsx';
import { useGameState } from '../../hooks/usePoll.js';
import { useCrisisFeed } from '../../hooks/useCrisisFeed.js';
import { areAllCardsRevealed, useRevealedCards } from '../../lib/revealedCards.js';
import DashboardTab from './DashboardTab.jsx';
import CardsTab from './CardsTab.jsx';
import ActionCardsTab from './ActionCardsTab.jsx';

const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'cards', label: 'My Cards' },
  { key: 'action', label: 'Action Cards' },
];

export default function PlayerApp() {
  const { user } = useAuth();
  const { revealed, reveal } = useRevealedCards(user?.teamId);
  const allRevealed = areAllCardsRevealed(revealed);
  const [tab, setTab] = useState(allRevealed ? 'dashboard' : 'cards');
  const { state, refreshNow } = useGameState(4000);
  const { pendingReveal, dismiss } = useCrisisFeed(user?.teamId, 4000);

  // if cards aren't all revealed yet (or a stale tab choice becomes locked),
  // always land the player back on My Cards
  useEffect(() => {
    if (!allRevealed && tab === 'dashboard') setTab('cards');
  }, [allRevealed, tab]);

  const badge = (key) => {
    if (key === 'action' && state?.pending_deal_offers_in > 0) return state.pending_deal_offers_in;
    return 0;
  };

  return (
    <div className="app-shell">
      {pendingReveal && <MayhemReveal crisis={pendingReveal} onClose={dismiss} />}
      <TopBar />
      <div className="tabbar">
        {TABS.map((t) => {
          const locked = t.key === 'dashboard' && !allRevealed;
          return (
            <button
              key={t.key}
              className={tab === t.key ? 'active' : ''}
              disabled={locked}
              title={locked ? 'Reveal all 4 of your starting cards to unlock the Dashboard' : undefined}
              onClick={() => !locked && setTab(t.key)}
            >
              {t.label}{badge(t.key) > 0 ? ` •${badge(t.key)}` : ''}{locked ? ' (locked)' : ''}
            </button>
          );
        })}
      </div>
      <div className="page">
        {tab === 'dashboard' && allRevealed && <DashboardTab gameState={state} />}
        {tab === 'cards' && <CardsTab gameState={state} revealed={revealed} onReveal={reveal} />}
        {tab === 'action' && <ActionCardsTab gameState={state} onChanged={refreshNow} />}
      </div>
    </div>
  );
}
