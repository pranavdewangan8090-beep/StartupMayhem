import { useEffect, useState } from 'react';
import { supabase, call, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';
import FlipCard from '../../components/FlipCard.jsx';
import Modal from '../../components/Modal.jsx';

const CATS = [
  { key: 'market', label: 'Market' },
  { key: 'customer', label: 'Customer' },
  { key: 'mission', label: 'Secret Mission' },
  { key: 'resources', label: 'Starting Resources' },
];

function cardStats(key, cards) {
  if (key !== 'resources') return null;
  return [
    { label: 'Cash', value: `₹${cards.start_cash_l / 10}M` },
    { label: 'Customers', value: `${(cards.start_customers / 1000).toFixed(0)}k` },
    { label: 'Reputation', value: `${cards.start_reputation}/5` },
    { label: 'Innovation', value: `${cards.start_innovation}/10` },
  ];
}

export default function CardsTab({ gameState, revealed, onReveal }) {
  const [cards, setCards] = useState(null);
  const [enlarged, setEnlarged] = useState(null); // category key
  const [busyCat, setBusyCat] = useState(null);
  const toast = useToast();

  async function load() {
    const rows = await call(supabase.rpc('fn_player_cards'));
    setCards(rows?.[0]);
  }
  useEffect(() => { load(); }, []);

  async function replace(category) {
    setBusyCat(category);
    try {
      await call(supabase.rpc('fn_replace_identity_card', { p_category: category }));
      toast(`New ${category} card drawn.`, 'success');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not replace card.', 'error');
    } finally {
      setBusyCat(null);
    }
  }

  if (!cards) return <div className="empty-state">Loading your cards…</div>;

  const remaining = 3 - cards.replacements_used;
  const replaceOpen = gameState?.r1_replace_open;

  return (
    <div>
      <div className="card-grid">
        {CATS.map((c) => {
          const title = cards[`${c.key}_title`];
          const tagline = cards[`${c.key}_tagline`];
          const description = cards[`${c.key}_desc`];
          const tags = cards[`${c.key}_tags`] || [];
          const stats = cardStats(c.key, cards);
          const isRevealed = revealed?.has(c.key);
          return (
            <FlipCard
              key={c.key}
              category={c.key}
              title={title}
              tagline={tagline}
              description={description}
              tags={c.key === 'mission' && cards.bonus_points ? [...tags, `+${cards.bonus_points} pts`] : tags}
              stats={stats}
              revealed={isRevealed}
              onReveal={onReveal}
              onEnlarge={() => setEnlarged(c.key)}
            >
              <button
                className="btn btn-ghost btn-sm replace-btn"
                disabled={!replaceOpen || remaining <= 0 || busyCat === c.key}
                onClick={(e) => { e.stopPropagation(); replace(c.key); }}
              >
                {busyCat === c.key ? 'Replacing…' : `Replace (${remaining} left)`}
              </button>
            </FlipCard>
          );
        })}
      </div>

      {enlarged && (
        <Modal onClose={() => setEnlarged(null)}>
          <span className={`pill cat-${enlarged}`}>{enlarged}</span>
          <h1>{cards[`${enlarged}_title`]}</h1>
          <p style={{ fontStyle: 'italic' }}>{cards[`${enlarged}_tagline`]}</p>
          <p>{cards[`${enlarged}_desc`]}</p>
          {enlarged === 'mission' && cards.bonus_points && (
            <p className="success-text">Bonus: +{cards.bonus_points} points</p>
          )}
          {enlarged === 'resources' && (
            <div className="grid-2" style={{ marginTop: 12 }}>
              {cardStats('resources', cards).map((s) => (
                <div className="stat-tile" key={s.label}><div className="value">{s.value}</div><div className="label">{s.label}</div></div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
