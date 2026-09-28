import { useEffect, useState } from 'react';
import { supabase, call, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';

const TOGGLES = [
  { key: 'r1_replace_open', label: 'R1: Card Replacements' },
  { key: 'r2_selection_open', label: 'R2: Action Card Selection' },
  { key: 'card_play_open', label: 'Playing Action Cards' },
];

const STATUS_LABEL = { pending: 'Pending', used_card: 'Use Action Card', traded: 'Traded', penalized: 'Penalized' };
const STATUS_OPTIONS = ['pending', 'used_card', 'traded', 'penalized'];

function StatusCell({ crisisId, team, busy, onSet }) {
  return (
    <select
      value={team.status}
      disabled={busy}
      onChange={(e) => onSet(crisisId, team.team_id, e.target.value)}
    >
      {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
    </select>
  );
}

export default function ControlRoomTab() {
  const [toggles, setToggles] = useState(null);
  const [crises, setCrises] = useState([]);
  const [selectedCrisisId, setSelectedCrisisId] = useState(null);
  const [crisisStatus, setCrisisStatus] = useState([]);
  const [usefulCards, setUsefulCards] = useState([]);
  const [tradeToggles, setTradeToggles] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
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
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadCrisisDetail(crisisId) {
    const [status, useful] = await Promise.all([
      call(supabase.rpc('fn_admin_crisis_status', { p_crisis_id: crisisId })),
      call(supabase.rpc('fn_admin_crisis_useful_cards', { p_crisis_id: crisisId })),
    ]);
    setCrisisStatus(status);
    setUsefulCards(useful);
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
      toast(`Crisis triggered: ${triggered.title}`, 'success');
      await load();
      setSelectedCrisisId(triggered.id);
      await loadCrisisDetail(triggered.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not trigger the next crisis.', 'error');
    } finally { setBusy(false); }
  }

  async function randomizeTeams(crisisId) {
    setBusy(true);
    try {
      await call(supabase.rpc('fn_super_randomize_crisis_teams', { p_crisis_id: crisisId, p_count: 2 }));
      toast('Placeholder affected teams assigned.', 'success');
      await loadCrisisDetail(crisisId);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not assign teams.', 'error');
    } finally { setBusy(false); }
  }

  async function setStatus(crisisId, teamId, status) {
    setBusy(true);
    try {
      await call(supabase.rpc('fn_super_set_crisis_team_status', { p_crisis_id: crisisId, p_team_id: teamId, p_status: status }));
      await loadCrisisDetail(crisisId);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update status.', 'error');
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
          <p><b>Useful action cards:</b> {usefulCards.length ? usefulCards.map((c) => c.name).join(', ') : 'None configured'}</p>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => randomizeTeams(selectedCrisis.id)}>
              Randomly Assign Placeholder Affected Teams
            </button>
          </div>
          <p>Affected teams and their resolution. "Use Action Card" and "Traded" mean no resource change. "Penalized" is a reminder to manually reduce that team's resources from the Teams tab.</p>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Team</th><th>Status</th><th>Last Updated</th></tr></thead>
              <tbody>
                {crisisStatus.map((t) => (
                  <tr key={t.team_id}>
                    <td><b>{t.team_code}</b></td>
                    <td><StatusCell crisisId={selectedCrisis.id} team={t} busy={busy} onSet={setStatus} /></td>
                    <td>{t.updated_by_login ? `${t.updated_by_login} · ${new Date(t.updated_at).toLocaleTimeString()}` : '—'}</td>
                  </tr>
                ))}
                {crisisStatus.length === 0 && (
                  <tr><td colSpan={3}>No affected teams assigned yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
