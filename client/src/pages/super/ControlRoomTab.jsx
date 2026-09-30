import { useEffect, useState } from 'react';
import { supabase, call, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';

const TOGGLES = [
  { key: 'r1_replace_open', label: 'R1: Card Replacements' },
  { key: 'card_play_open', label: 'Playing Action Cards' },
];

const TIER_LABEL = { hit_hard: 'Hit Hard', hit: 'Hit', unaffected: 'Unaffected', gains: 'Gains' };

function formatDelta(applied) {
  if (!applied) return '—';
  const parts = [];
  if (applied.cash_l) parts.push(`${applied.cash_l > 0 ? '+' : ''}₹${applied.cash_l / 10}M Cash`);
  if (applied.customers) parts.push(`${applied.customers > 0 ? '+' : ''}${applied.customers / 1000}k Customers`);
  if (applied.reputation) parts.push(`${applied.reputation > 0 ? '+' : ''}${applied.reputation} Reputation`);
  if (applied.innovation) parts.push(`${applied.innovation > 0 ? '+' : ''}${applied.innovation} Innovation`);
  if (applied.decision_points) parts.push(`${applied.decision_points > 0 ? '+' : ''}${applied.decision_points} pts`);
  return parts.length ? parts.join(' · ') : 'No change';
}

export default function ControlRoomTab() {
  const [toggles, setToggles] = useState(null);
  const [crises, setCrises] = useState([]);
  const [selectedCrisisId, setSelectedCrisisId] = useState(null);
  const [crisisEffects, setCrisisEffects] = useState([]);
  const [tradeToggles, setTradeToggles] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    try {
      const [t, cr, tt] = await Promise.all([
        call(supabase.rpc('fn_super_toggles_get')),
        call(supabase.rpc('fn_admin_crisis_list')),
        call(supabase.rpc('fn_super_trade_toggles_all')),
      ]);
      setToggles(t);
      setCrises(cr);
      setTradeToggles(tt);
      const firstTriggered = cr.find((c) => c.is_triggered)?.id ?? null;
      const nextSelected = selectedCrisisId ?? firstTriggered;
      setSelectedCrisisId(nextSelected);
      if (nextSelected) await loadCrisisDetail(nextSelected);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the control room.', 'error');
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadCrisisDetail(crisisId) {
    try {
      setCrisisEffects(await call(supabase.rpc('fn_admin_crisis_effects', { p_crisis_id: crisisId })));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load crisis details.', 'error');
    }
  }

  async function selectCrisis(id) {
    setSelectedCrisisId(id);
    await loadCrisisDetail(id);
  }

  async function flip(key, value) {
    setBusy(true);
    try {
      await call(supabase.rpc('fn_super_toggles_set', { p_key: key, p_value: value }));
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update toggle.', 'error');
    } finally { setBusy(false); }
  }

  async function triggerCrisis() {
    setBusy(true);
    try {
      const triggered = await call(supabase.rpc('fn_super_trigger_crisis'));
      toast(`Crisis triggered: ${triggered.title} — effects applied to every team.`, 'success');
      await load();
      setSelectedCrisisId(triggered.id);
      await loadCrisisDetail(triggered.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not trigger the next crisis.', 'error');
    } finally { setBusy(false); }
  }

  async function toggleTrading(enabled) {
    setBusy(true);
    try {
      await call(supabase.rpc('fn_super_trade_toggle_set', { p_enabled: enabled }));
      toast(`You turned trading ${enabled ? 'ON' : 'OFF'} for your account.`, 'success');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update the trade toggle.', 'error');
    } finally { setBusy(false); }
  }

  if (!toggles) return <div className="empty-state">Loading…</div>;

  const triggeredCount = crises.filter((c) => c.is_triggered).length;
  const allTriggered = crises.length > 0 && triggeredCount === crises.length;
  const selectedCrisis = crises.find((c) => c.id === selectedCrisisId);
  const effectiveTradingOn = tradeToggles?.some((t) => t.enabled) ?? false;

  return (
    <div>
      <div className="desktop-grid">
        <div className="card-surface section">
          <h2>Game Toggles</h2>
          {TOGGLES.map((t) => (
            <div key={t.key} className="toggle-row">
              <span>{t.label}</span>
              <button
                className={`btn btn-sm ${toggles[t.key] ? 'btn-success' : 'btn-ghost'}`}
                disabled={busy}
                onClick={() => flip(t.key, !toggles[t.key])}
              >
                {toggles[t.key] ? 'ON' : 'OFF'}
              </button>
            </div>
          ))}
        </div>

        <div className="card-surface section">
          <h2>Card Trading</h2>
          <p>
            Overall status: <b className={effectiveTradingOn ? 'success-text' : 'warning-text'}>
              {effectiveTradingOn ? 'ENABLED' : 'DISABLED'}
            </b>
          </p>
          <p>ON as soon as one Super Admin enables it. OFF only once every Super Admin disables it.</p>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn btn-success btn-sm" disabled={busy} onClick={() => toggleTrading(true)}>Turn ON (mine)</button>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => toggleTrading(false)}>Turn OFF (mine)</button>
          </div>
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="data-table">
              <thead><tr><th>Super Admin</th><th>Their Setting</th></tr></thead>
              <tbody>
                {tradeToggles?.map((t) => (
                  <tr key={t.super_admin_login}>
                    <td>{t.super_admin_login}</td>
                    <td>{t.enabled ? 'ON' : 'OFF'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card-surface section">
          <h2>Round 3: Crises</h2>
          <p>{triggeredCount} of {crises.length} crises triggered.</p>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn btn-danger" disabled={busy || allTriggered} onClick={triggerCrisis}>
              {allTriggered ? 'All Crises Triggered' : 'Trigger Next Crisis'}
            </button>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {crises.filter((c) => c.is_triggered).map((c) => (
              <button
                key={c.id}
                className={`btn btn-sm ${selectedCrisisId === c.id ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => selectCrisis(c.id)}
              >
                {c.title}
              </button>
            ))}
          </div>
        </div>
      </div>

      {selectedCrisis && (
        <div className="card-surface section">
          <h2>Crisis {selectedCrisis.number}: {selectedCrisis.title}</h2>
          <p>{selectedCrisis.description || 'Every active team\'s tier was determined automatically by their Market card, and the effect below was already applied to their resources the moment this crisis was triggered.'}</p>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Team</th><th>Tier</th><th>Effect Applied</th></tr></thead>
              <tbody>
                {crisisEffects.map((t) => (
                  <tr key={t.team_id}>
                    <td><b>{t.team_code}</b></td>
                    <td>{t.tier ? <span className={`pill tier-${t.tier}`}>{TIER_LABEL[t.tier]}</span> : '—'}</td>
                    <td>{formatDelta(t.applied)}</td>
                  </tr>
                ))}
                {crisisEffects.length === 0 && (
                  <tr><td colSpan={3}>No teams yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
