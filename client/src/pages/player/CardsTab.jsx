import { useEffect, useState } from 'react';
import { api, newRequestId, ApiError } from '../../lib/api.js';
import { useToast } from '../../lib/ToastContext.jsx';
import FlipCard from '../../components/FlipCard.jsx';
import Modal from '../../components/Modal.jsx';

const CATS = [
  { key: 'market', label: 'Market' },
  { key: 'customer', label: 'Customer' },
  { key: 'problem', label: 'Problem' },
  { key: 'mission', label: 'Secret Mission' },
  { key: 'resources', label: 'Starting Resources' },
];

export default function CardsTab({ gameState }) {
  const [cards, setCards] = useState(null);
  const [enlarged, setEnlarged] = useState(null); // category key
  const [busyCat, setBusyCat] = useState(null);
  const toast = useToast();

  async function load() {
    setCards(await api.get('/player/cards'));
  }
  useEffect(() => { load(); }, []);

  async function replace(category) {
    setBusyCat(category);
    try {
      await api.post('/player/cards/replace', { category, requestId: newRequestId() });
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
      <div className="section card-surface" style={{ marginBottom: 16 }}>
        <h2>Your 5 Starting Cards</h2>
        <p>Tap a card to flip it, tap again to enlarge. You have <b>{remaining}</b> card replacement{remaining === 1 ? '' : 's'} left.</p>
        {!replaceOpen && <p style={{ color: 'var(--warning)' }}>Replacements are currently closed by the Super Admin.</p>}
      </div>

      <div className="card-grid">
        {CATS.map((c) => {
          const id = cards[`${c.key}_id`];
          const title = cards[`${c.key}_title`];
          const tagline = cards[`${c.key}_tagline`];
          return (
            <FlipCard
              key={c.key}
              category={c.key}
              title={title}
              tagline={tagline}
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
            <p style={{ color: 'var(--success)' }}>Bonus: +{cards.bonus_points} points</p>
          )}
        </Modal>
      )}
    </div>
  );
}
