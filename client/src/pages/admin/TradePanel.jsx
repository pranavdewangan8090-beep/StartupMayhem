import { useEffect, useState } from 'react';
import { supabase, call, newRequestId, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';

const emptyForm = {
  teamAId: '', teamACardId: '',
  teamBId: '', teamBCardId: '',
  moneyTeamId: '', moneyAmount: 0,
  crisisId: '',
};

export default function TradePanel() {
  const [teams, setTeams] = useState([]);
  const [crises, setCrises] = useState([]);
  const [tradeStatus, setTradeStatus] = useState(null);
  const [teamACards, setTeamACards] = useState([]);
  const [teamBCards, setTeamBCards] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    try {
      const [t, cr, status] = await Promise.all([
        call(supabase.rpc('fn_admin_teams')),
        call(supabase.rpc('fn_admin_crisis_list')),
        call(supabase.rpc('fn_trade_feature_status')),
      ]);
      setTeams(t);
      setCrises(cr.filter((c) => c.is_triggered));
      setTradeStatus(Array.isArray(status) ? status[0] : status);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load teams.', 'error');
    }
  }
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!form.teamAId) { setTeamACards([]); return; }
    call(supabase.rpc('fn_admin_team_cards', { p_team_id: Number(form.teamAId) }))
      .then((cards) => setTeamACards(cards.filter((c) => c.status === 'held')))
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not load team A's cards.", 'error'));
  }, [form.teamAId]);

  useEffect(() => {
    if (!form.teamBId) { setTeamBCards([]); return; }
    call(supabase.rpc('fn_admin_team_cards', { p_team_id: Number(form.teamBId) }))
      .then((cards) => setTeamBCards(cards.filter((c) => c.status === 'held')))
      .catch((err) => toast(err instanceof ApiError ? err.message : "Could not load team B's cards.", 'error'));
  }, [form.teamBId]);

  const enabled = tradeStatus?.enabled;
  const canSubmit = enabled && form.teamAId && form.teamACardId && form.teamBId && form.teamBCardId
    && form.teamAId !== form.teamBId
    && (!Number(form.moneyAmount) || form.moneyTeamId);

  async function submitTrade() {
    setBusy(true);
    try {
      await call(supabase.rpc('fn_admin_process_trade', {
        p_team_a_id: Number(form.teamAId),
        p_team_a_card_id: form.teamACardId,
        p_team_b_id: Number(form.teamBId),
        p_team_b_card_id: form.teamBCardId,
        p_money_team_id: form.moneyTeamId ? Number(form.moneyTeamId) : null,
        p_money_amount: Number(form.moneyAmount) || 0,
        p_crisis_id: form.crisisId ? Number(form.crisisId) : null,
        p_request_id: newRequestId(),
      }));
      toast('Trade processed.', 'success');
      setForm(emptyForm);
      setTeamACards([]);
      setTeamBCards([]);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not process the trade.', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="card-surface section">
        <h1>Process a Trade</h1>
        <p>Both teams must have already agreed to the exchange off-app. Enter the two team codes and the exact card each is giving up.</p>
        {tradeStatus && !enabled && (
          <p className="warning-text">Card trading is currently switched OFF by the Super Admins. Trades cannot be processed.</p>
        )}
      </div>

      <div className="card-surface section">
        <div className="grid-2">
          <div className="field">
            <label>Team A</label>
            <select value={form.teamAId} onChange={(e) => setForm({ ...form, teamAId: e.target.value, teamACardId: '' })}>
              <option value="">Select team…</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.team_code}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Team A's card to give up</label>
            <select value={form.teamACardId} onChange={(e) => setForm({ ...form, teamACardId: e.target.value })} disabled={!form.teamAId}>
              <option value="">Select card…</option>
              {teamACards.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.category})</option>)}
            </select>
          </div>

          <div className="field">
            <label>Team B</label>
            <select value={form.teamBId} onChange={(e) => setForm({ ...form, teamBId: e.target.value, teamBCardId: '' })}>
              <option value="">Select team…</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.team_code}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Team B's card to give up</label>
            <select value={form.teamBCardId} onChange={(e) => setForm({ ...form, teamBCardId: e.target.value })} disabled={!form.teamBId}>
              <option value="">Select card…</option>
              {teamBCards.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.category})</option>)}
            </select>
          </div>

          <div className="field">
            <label>Money involved (₹ lakhs, 10 = ₹1M) — 0 if none</label>
            <input type="number" min="0" value={form.moneyAmount} onChange={(e) => setForm({ ...form, moneyAmount: e.target.value })} />
          </div>
          <div className="field">
            <label>Team paying the money</label>
            <select value={form.moneyTeamId} onChange={(e) => setForm({ ...form, moneyTeamId: e.target.value })} disabled={!Number(form.moneyAmount)}>
              <option value="">No money involved</option>
              {form.teamAId && <option value={form.teamAId}>Team A</option>}
              {form.teamBId && <option value={form.teamBId}>Team B</option>}
            </select>
          </div>

          <div className="field">
            <label>Related crisis (optional)</label>
            <select value={form.crisisId} onChange={(e) => setForm({ ...form, crisisId: e.target.value })}>
              <option value="">None</option>
              {crises.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </div>
        </div>

        <button className="btn btn-primary btn-block" disabled={busy || !canSubmit} onClick={submitTrade} style={{ marginTop: 16 }}>
          Trade
        </button>
      </div>
    </div>
  );
}
