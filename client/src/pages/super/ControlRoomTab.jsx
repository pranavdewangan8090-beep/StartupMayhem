import { useEffect, useState } from 'react';
import { supabase, call, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';
import Switch from '../../components/Switch.jsx';
import ConfirmModal from '../../components/ConfirmModal.jsx';

const TOGGLES = [
  { key: 'r1_replace_open', label: 'R1: Card Replacements' },
  { key: 'card_play_open', label: 'Round 3: Play Special/Action/Deal Cards' },
];

const TIER_LABEL = { hit_hard: 'Hit Hard', hit: 'Hit', unaffected: 'Unaffected', gains: 'Gains' };

function formatDelta(applied) {
  if (!applied) return '—';
  const parts = [];
  if (applied.cash_l) parts.push(`${applied.cash_l > 0 ? '+' : ''}₹${applied.cash_l / 10}M Cash`);
  if (applied.customers) parts.push(`${applied.customers > 0 ? '+' : ''}${applied.customers / 1000}k Customers`);
  if (applied.reputation) parts.push(`${applied.reputation > 0 ? '+' : ''}${applied.reputation} Reputation`);
  if (applied.innovation) parts.push(`${applied.innovation > 0 ? '+' : ''}${applied.innovation} Innovation`);
  return parts.length ? parts.join(' · ') : 'No change';
}

export default function ControlRoomTab() {
  const [toggles, setToggles] = useState(null);
  const [crises, setCrises] = useState([]);
  const [selectedCrisisId, setSelectedCrisisId] = useState(null);
  const [crisisEffects, setCrisisEffects] = useState([]);
  const [tradeToggles, setTradeToggles] = useState(null);
  const [tradeStatus, setTradeStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmCrisis, setConfirmCrisis] = useState(null); // the crisis row about to be triggered
  const toast = useToast();

  async function load() {
    try {
      const [t, cr, tt, ts] = await Promise.all([
        call(supabase.rpc('fn_super_toggles_get')),
        call(supabase.rpc('fn_admin_crisis_list')),
        call(supabase.rpc('fn_super_trade_toggles_all')),
        call(supabase.rpc('fn_trade_feature_status')),
      ]);
      setToggles(t);
      setCrises(cr);
      setTradeToggles(tt);
      setTradeStatus(Array.isArray(ts) ? ts[0] : ts);
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

  // The exact crisis the Super Admin confirmed is sent along; if another
  // Super Admin triggered it in the meantime the server refuses
  // (CRISIS_OUT_OF_ORDER) instead of firing the NEXT one by accident.
  async function triggerCrisis() {
    const crisis = confirmCrisis;
    setBusy(true);
    try {
      const triggered = await call(supabase.rpc('fn_super_trigger_crisis', { p_crisis_id: crisis.id }));
      setConfirmCrisis(null);
      toast(`Crisis triggered: ${triggered.title} — effects applied to every team.`, 'success');
      await load();
      setSelectedCrisisId(triggered.id);
      await loadCrisisDetail(triggered.id);
    } catch (err) {
      setConfirmCrisis(null);
      toast(err instanceof ApiError ? err.message : 'Could not trigger the next crisis.', 'error');
      await load();
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
  const nextCrisis = crises.find((c) => !c.is_triggered);
  const effectiveTradingOn = tradeToggles?.some((t) => t.enabled) ?? false;

  return (
    <div>
      <div className="control-room-top-row">
        <div className="card-surface section">
          <div className="admin-card-head"><h2>Game Toggles</h2></div>
          {TOGGLES.map((t) => (
            <div key={t.key} className="toggle-row">
              <span>{t.label}</span>
              <Switch on={!!toggles[t.key]} disabled={busy} onClick={() => flip(t.key, !toggles[t.key])} label={t.label} />
            </div>
          ))}
        </div>

        <div className="card-surface section">
          <div className="admin-card-head">
            <h2>Card Trading</h2>
            <span className={`pill ${effectiveTradingOn ? 'tier-gains' : 'tier-unaffected'}`}>
              {effectiveTradingOn ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="toggle-row">
            <span>My setting</span>
            <Switch on={!!tradeStatus?.mine} disabled={busy} onClick={() => toggleTrading(!tradeStatus?.mine)} label="My trading toggle" />
          </div>
          <p className="admin-card-hint">Needs every Super Admin off to fully disable.</p>
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="data-table">
              <thead><tr><th>Super Admin</th><th>Setting</th></tr></thead>
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
      </div>

      <div className="card-surface section" style={{ marginTop: 16 }}>
        <div className="admin-card-head">
          <h2>Round 3: Crises</h2>
          <span className="admin-card-hint">{triggeredCount}/{crises.length} triggered</span>
        </div>
        <button className="btn btn-danger btn-sm" disabled={busy || allTriggered || !nextCrisis} onClick={() => setConfirmCrisis(nextCrisis)}>
          {allTriggered ? 'All Crises Triggered' : `Trigger Crisis ${nextCrisis?.number ?? ''}`}
        </button>
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
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

      {selectedCrisis && (
        <div className="card-surface section" style={{ marginTop: 16 }}>
          <div className="admin-card-head">
            <h2>Crisis {selectedCrisis.number}: {selectedCrisis.title}</h2>
          </div>
          <p className="admin-card-hint">{selectedCrisis.description || 'Every active team\'s tier was determined automatically by their Market card, and the effect below was already applied to their resources the moment this crisis was triggered.'}</p>
          <div className="table-scroll" style={{ marginTop: 12 }}>
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

      {confirmCrisis && (
        <ConfirmModal
          title={`Trigger Crisis ${confirmCrisis.number}: ${confirmCrisis.title}?`}
          confirmLabel="Trigger crisis"
          danger
          busy={busy}
          onConfirm={triggerCrisis}
          onCancel={() => setConfirmCrisis(null)}
        >
          <p>This immediately applies the crisis to <b>every active team's</b> resources and decision points, shows it on every player's phone, and closes R1 replacements.</p>
          <p className="warning-text">It cannot be undone from the app.</p>
        </ConfirmModal>
      )}
    </div>
  );
}
