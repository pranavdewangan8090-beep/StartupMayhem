import { useEffect, useState } from 'react';
import { api, newRequestId, ApiError } from '../../lib/api.js';
import { useToast } from '../../lib/ToastContext.jsx';
import Modal from '../../components/Modal.jsx';

const CAT_LABEL = { self_help: 'Self Help', attack: 'Attack', deal: 'Deal', special: 'Special / AI' };

export default function ActionCardsTab({ gameState, onChanged }) {
  const [catalog, setCatalog] = useState([]);
  const [hand, setHand] = useState([]);
  const [teams, setTeams] = useState([]);
  const [incomingDeals, setIncomingDeals] = useState([]);
  const [playTarget, setPlayTarget] = useState(null); // { card, mode: 'attack'|'deal' }
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function loadAll() {
    const [c, h, t, d] = await Promise.all([
      api.get('/action-cards/catalog'),
      api.get('/action-cards/hand'),
      api.get('/action-cards/teams'),
      api.get('/action-cards/deals/incoming'),
    ]);
    setCatalog(c);
    setHand(h);
    setTeams(t);
    setIncomingDeals(d);
  }
  useEffect(() => { loadAll(); }, [gameState?.action_card_count, gameState?.pending_deal_offers_in]);

  async function request(actionCardId) {
    setBusy(true);
    try {
      await api.post('/action-cards/request', { actionCardId, requestId: newRequestId() });
      toast('Card requested!', 'success');
      await loadAll();
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not request card.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function playSelf(teamActionCardId) {
    setBusy(true);
    try {
      const result = await api.post('/action-cards/play/self', { teamActionCardId, requestId: newRequestId() });
      toast('Card played!', 'success');
      await loadAll();
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not play card.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmTargeted() {
    if (!selectedTeamId) return;
    setBusy(true);
    try {
      if (playTarget.mode === 'attack') {
        await api.post('/action-cards/play/attack', {
          teamActionCardId: playTarget.card.id,
          targetTeamId: Number(selectedTeamId),
          requestId: newRequestId(),
        });
        toast('Attack launched!', 'success');
      } else {
        await api.post('/action-cards/play/deal', {
          teamActionCardId: playTarget.card.id,
          partnerTeamId: Number(selectedTeamId),
          requestId: newRequestId(),
        });
        toast('Deal proposed — waiting for their response.', 'success');
      }
      setPlayTarget(null);
      setSelectedTeamId('');
      await loadAll();
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not play card.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function respondDeal(cardPlayId, accept) {
    setBusy(true);
    try {
      await api.post('/action-cards/deals/respond', { cardPlayId, accept, requestId: newRequestId() });
      toast(accept ? 'Deal accepted!' : 'Deal rejected.', accept ? 'success' : 'info');
      await loadAll();
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not respond.', 'error');
    } finally {
      setBusy(false);
    }
  }

  const heldIds = new Set(hand.map((c) => c.action_card_id));
  const canRequestMore = hand.filter((c) => c.source === 'r2').length < 4;

  return (
    <div>
      {incomingDeals.length > 0 && (
        <div className="card-surface section" style={{ borderColor: 'var(--cat-deal)' }}>
          <h2>Deal Offers For You</h2>
          {incomingDeals.map((d) => (
            <div key={d.id} className="action-card-tile cat-deal" style={{ marginBottom: 10 }}>
              <div className="name">{d.name} — from {d.from_team_code}</div>
              <div className="effect">{d.effect_text}</div>
              <div className="row">
                <button className="btn btn-success btn-sm" disabled={busy} onClick={() => respondDeal(d.id, true)}>Accept</button>
                <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => respondDeal(d.id, false)}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card-surface section">
        <h2>Your Hand ({hand.filter((c) => c.status !== 'used').length})</h2>
        {hand.length === 0 && <p>You haven't requested any action cards yet.</p>}
        {hand.map((c) => (
          <div key={c.id} className={`action-card-tile cat-${c.category} ${c.status === 'listed' ? 'listed' : ''}`} style={{ marginBottom: 10 }}>
            <span className={`pill cat-${c.category}`}>{CAT_LABEL[c.category]}</span>
            <div className="name" style={{ marginTop: 6 }}>{c.name}</div>
            <div className="effect">{c.effect_text}</div>
            {c.status === 'listed' && <p style={{ color: 'var(--warning)' }}>On the marketplace — not usable.</p>}
            {c.status === 'pending' && <p style={{ color: 'var(--text-dim)' }}>Awaiting response…</p>}
            {c.status === 'used' && <p style={{ color: 'var(--text-dim)' }}>Already used.</p>}
            {c.status === 'held' && gameState?.card_play_open && (
              <div className="row">
                {c.category === 'self_help' || c.category === 'special' ? (
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => playSelf(c.id)}>Play</button>
                ) : c.category === 'attack' ? (
                  <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => setPlayTarget({ card: c, mode: 'attack' })}>Attack…</button>
                ) : (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPlayTarget({ card: c, mode: 'deal' })}>Propose Deal…</button>
                )}
              </div>
            )}
            {c.status === 'held' && !gameState?.card_play_open && <p style={{ color: 'var(--warning)' }}>Playing cards is closed right now.</p>}
          </div>
        ))}
      </div>

      <div className="card-surface section">
        <h2>Action Card Catalog</h2>
        <p>{gameState?.r2_selection_open ? `Pick up to 4 cards, one request at a time.` : 'Selection is currently closed by the Super Admin.'}</p>
        {catalog.map((c) => (
          <div key={c.id} className={`action-card-tile cat-${c.category}`} style={{ marginBottom: 10, opacity: heldIds.has(c.id) ? 0.5 : 1 }}>
            <span className={`pill cat-${c.category}`}>{CAT_LABEL[c.category]}</span>
            <div className="name" style={{ marginTop: 6 }}>{c.name}</div>
            <div className="effect">{c.effect_text}</div>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy || !gameState?.r2_selection_open || !canRequestMore || heldIds.has(c.id)}
              onClick={() => request(c.id)}
            >
              {heldIds.has(c.id) ? 'Already requested' : 'Make Request'}
            </button>
          </div>
        ))}
      </div>

      {playTarget && (
        <Modal onClose={() => setPlayTarget(null)}>
          <h2>{playTarget.mode === 'attack' ? 'Choose a target' : 'Choose a partner'}</h2>
          <p>{playTarget.card.name}</p>
          <div className="field">
            <select value={selectedTeamId} onChange={(e) => setSelectedTeamId(e.target.value)}>
              <option value="">Select a team…</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.team_code}</option>)}
            </select>
          </div>
          <button className="btn btn-primary btn-block" disabled={busy || !selectedTeamId} onClick={confirmTargeted}>
            Confirm
          </button>
        </Modal>
      )}
    </div>
  );
}
