import { useEffect, useState } from 'react';
import { api, newRequestId, ApiError } from '../../lib/api.js';
import { useToast } from '../../lib/ToastContext.jsx';

const TOGGLES = [
  { key: 'r1_replace_open', label: 'R1: Card Replacements' },
  { key: 'r2_selection_open', label: 'R2: Action Card Selection' },
  { key: 'card_play_open', label: 'Playing Action Cards' },
];

const RESPONSE_LABEL = { accept: 'Accept', spend: 'Spend', adapt: 'Adapt', partner: 'Partner' };
const TIER_LABEL = { hit_hard: 'Hit Hard', hit: 'Hit', unaffected: 'Unaffected', gains: 'Gains' };

function formatDelta(applied) {
  if (!applied) return '';
  const parts = [];
  if (applied.cash_l) parts.push(`${applied.cash_l > 0 ? '+' : ''}₹${applied.cash_l / 10}M Cash`);
  if (applied.customers) parts.push(`${applied.customers > 0 ? '+' : ''}${applied.customers / 1000}k Customers`);
  if (applied.reputation) parts.push(`${applied.reputation > 0 ? '+' : ''}${applied.reputation} Reputation`);
  if (applied.innovation) parts.push(`${applied.innovation > 0 ? '+' : ''}${applied.innovation} Innovation`);
  return parts.length ? parts.join(' · ') : 'No change';
}

function ResponseForm({ team, teams, busy, onSubmit }) {
  const [response, setResponse] = useState('accept');
  const [partnerTeamId, setPartnerTeamId] = useState('');
  const needsPartner = response === 'partner' && (team.tier === 'hit_hard' || team.tier === 'hit');

  return (
    <div className="response-form">
      <select value={response} onChange={(e) => setResponse(e.target.value)}>
        {Object.entries(RESPONSE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {needsPartner && (
        <select value={partnerTeamId} onChange={(e) => setPartnerTeamId(e.target.value)}>
          <option value="">Partner team…</option>
          {teams.filter((t) => t.team_id !== team.team_id).map((t) => (
            <option key={t.team_id} value={t.team_id}>{t.team_code}</option>
          ))}
        </select>
      )}
      <button
        className="btn btn-primary btn-sm"
        disabled={busy || (needsPartner && !partnerTeamId)}
        onClick={() => onSubmit(team.team_id, response, partnerTeamId ? Number(partnerTeamId) : null)}
      >
        Record
      </button>
    </div>
  );
}

export default function ControlRoomTab() {
  const [toggles, setToggles] = useState(null);
  const [events, setEvents] = useState([]);
  const [mayhem, setMayhem] = useState(null);
  const [teamStatus, setTeamStatus] = useState([]);
  const [showOverlay, setShowOverlay] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    const [t, ev, m] = await Promise.all([
      api.get('/super-admin/toggles'),
      api.get('/mayhem/events'),
      api.get('/mayhem/current'),
    ]);
    setToggles(t);
    setEvents(ev);
    setMayhem(m);
    setTeamStatus(m ? await api.get('/mayhem/team-status') : []);
  }
  useEffect(() => { load(); }, []);

  async function flip(key, value) {
    setBusy(true);
    try {
      await api.post('/super-admin/toggles', { key, value });
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update toggle.', 'error');
    } finally { setBusy(false); }
  }

  async function trigger() {
    setBusy(true);
    try {
      const triggered = await api.post('/mayhem/trigger', {});
      // set the mayhem + open the overlay from the trigger response itself
      // (no round trip through load() needed to know what just got triggered)
      setMayhem(triggered);
      setShowOverlay(true);
      toast('Mayhem event triggered!', 'success');
      const [ev, ts] = await Promise.all([api.get('/mayhem/events'), api.get('/mayhem/team-status')]);
      setEvents(ev);
      setTeamStatus(ts);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not trigger the next event.', 'error');
    } finally { setBusy(false); }
  }

  async function recordResponse(teamId, response, partnerTeamId) {
    setBusy(true);
    try {
      await api.post('/mayhem/respond', { teamId, response, partnerTeamId, requestId: newRequestId() });
      toast('Response recorded.', 'success');
      setTeamStatus(await api.get('/mayhem/team-status'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not record response.', 'error');
    } finally { setBusy(false); }
  }

  if (!toggles) return <div className="empty-state">Loading…</div>;

  const triggeredCount = events.filter((e) => e.is_triggered).length;
  const allTriggered = events.length > 0 && triggeredCount === events.length;

  return (
    <div>
      {mayhem && showOverlay && (
        <div className="mayhem-overlay" onClick={() => setShowOverlay(false)}>
          <div className="mayhem-overlay-card" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowOverlay(false)} aria-label="Close">&times;</button>
            <span className="pill mayhem-event-pill">Event {mayhem.number} of 3</span>
            <h1>{mayhem.title}</h1>
            <p className="mayhem-overlay-story">{mayhem.story_text}</p>
            <p className="mayhem-overlay-effect"><b>Effect:</b> {mayhem.effect_text}</p>
            <div className="tag-row" style={{ marginTop: 10 }}>
              {mayhem.tags?.map((t) => <span key={t} className="tag-chip">{t}</span>)}
            </div>
          </div>
        </div>
      )}

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
          <h2>Round 3: Market Mayhem</h2>
          <p>{triggeredCount} of {events.length} events triggered.</p>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn btn-danger" disabled={busy || allTriggered} onClick={trigger}>
              {allTriggered ? 'All Events Triggered' : 'Trigger Next Event'}
            </button>
            {mayhem && (
              <button className="btn btn-ghost" onClick={() => setShowOverlay(true)}>Show Event</button>
            )}
          </div>
        </div>
      </div>

      {mayhem && (
        <div className="card-surface section">
          <h2>Event {mayhem.number}: {mayhem.title}</h2>
          <p>Record each team's response as decided at the table. Effects apply automatically.</p>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Team</th><th>Market</th><th>Tier</th><th>Response</th></tr>
              </thead>
              <tbody>
                {teamStatus.map((t) => (
                  <tr key={t.team_id}>
                    <td><b>{t.team_code}</b></td>
                    <td>{t.market_title}</td>
                    <td><span className={`pill tier-${t.tier}`}>{TIER_LABEL[t.tier] || t.tier}</span></td>
                    <td>
                      {t.response ? (
                        <span className="response-recorded">
                          {RESPONSE_LABEL[t.response]}{t.partner_team_code ? ` w/ ${t.partner_team_code}` : ''} — {formatDelta(t.applied)}
                        </span>
                      ) : (
                        <ResponseForm team={t} teams={teamStatus} busy={busy} onSubmit={recordResponse} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
