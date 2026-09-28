import { useEffect, useState } from 'react';
import { supabase, call, newRequestId, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';
import Modal from '../../components/Modal.jsx';

const CAT_LABEL = { action: 'Action Card', deal: 'Deal', special: 'Special / AI' };

export default function ActionCardsTab({ gameState, onChanged }) {
  const [hand, setHand] = useState([]);
  const [teams, setTeams] = useState([]);
  const [incomingDeals, setIncomingDeals] = useState([]);
  const [playTarget, setPlayTarget] = useState(null); // { card }
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function loadAll() {
    const [h, t, d] = await Promise.all([
      call(supabase.rpc('fn_player_hand')),
      call(supabase.rpc('fn_other_teams')),
      call(supabase.rpc('fn_deals_incoming')),
    ]);
    setHand(h);
    setTeams(t);
    setIncomingDeals(d);
  }
  useEffect(() => { loadAll(); }, [gameState?.action_card_count, gameState?.pending_deal_offers_in]);

  async function playSelf(teamActionCardId) {
    setBusy(true);
    try {
      await call(supabase.rpc('fn_play_self_card', { p_team_action_card_id: teamActionCardId, p_request_id: newRequestId() }));
      toast('Card played!', 'success');
      await loadAll();
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not play card.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeal() {
    if (!selectedTeamId) return;
    setBusy(true);
    try {
      await call(supabase.rpc('fn_play_deal_card', {
        p_team_action_card_id: playTarget.card.id,
        p_partner_team_id: Number(selectedTeamId),
        p_request_id: newRequestId(),
      }));
      toast('Deal proposed — waiting for their response.', 'success');
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
      await call(supabase.rpc('fn_respond_deal_card', { p_card_play_id: cardPlayId, p_accept: accept, p_request_id: newRequestId() }));
      toast(accept ? 'Deal accepted!' : 'Deal rejected.', accept ? 'success' : 'info');
      await loadAll();
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not respond.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {incomingDeals.length > 0 && (
        <div className="card-surface section" style={{ borderColor: 'var(--cat-deal)' }}>
          <h2>Deal Offers For You</h2>
          <div className="action-grid">
            {incomingDeals.map((d) => (
              <div key={d.id} className="action-card-tile cat-deal">
                <div className="name">{d.name} — from {d.from_team_code}</div>
                <div className="effect">{d.effect_text}</div>
                <div className="row">
                  <button className="btn btn-success btn-sm" disabled={busy} onClick={() => respondDeal(d.id, true)}>Accept</button>
                  <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => respondDeal(d.id, false)}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card-surface section">
        <h2>Your Action Cards ({hand.filter((c) => c.status !== 'used').length}/3)</h2>
        <p>You were issued one Action, one Deal and one Special/AI card at the start of the game. You can only exchange one of these for a different card during Round 3, through an admin-processed trade.</p>
        {hand.length === 0 && <p>Loading your cards…</p>}
        <div className="action-grid">
          {hand.map((c) => (
            <div key={c.id} className={`action-card-tile cat-${c.category}`}>
              <span className={`pill cat-${c.category}`}>{CAT_LABEL[c.category]}</span>
              <div className="name" style={{ marginTop: 6 }}>{c.name}</div>
              <div className="effect">{c.effect_text}</div>
              {c.status === 'pending' && <p>Awaiting response…</p>}
              {c.status === 'used' && <p>Already used.</p>}
              {c.status === 'held' && gameState?.card_play_open && (
                <div className="row">
                  {c.category === 'action' || c.category === 'special' ? (
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => playSelf(c.id)}>Play</button>
                  ) : (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPlayTarget({ card: c })}>Propose Deal…</button>
                  )}
                </div>
              )}
              {c.status === 'held' && !gameState?.card_play_open && <p className="warning-text">Playing cards is closed right now.</p>}
            </div>
          ))}
        </div>
      </div>

      {playTarget && (
        <Modal onClose={() => setPlayTarget(null)}>
          <h2>Choose a partner</h2>
          <p>{playTarget.card.name}</p>
          <div className="field">
            <select value={selectedTeamId} onChange={(e) => setSelectedTeamId(e.target.value)}>
              <option value="">Select a team…</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.team_code}</option>)}
            </select>
          </div>
          <button className="btn btn-primary btn-block" disabled={busy || !selectedTeamId} onClick={confirmDeal}>
            Confirm
          </button>
        </Modal>
      )}
    </div>
  );
}
