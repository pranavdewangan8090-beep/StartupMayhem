import { useEffect, useState } from 'react';
import { api, newRequestId, ApiError } from '../../lib/api.js';
import { useToast } from '../../lib/ToastContext.jsx';

const TOGGLES = [
  { key: 'r1_replace_open', label: 'R1: Card Replacements' },
  { key: 'r2_selection_open', label: 'R2: Action Card Selection' },
  { key: 'marketplace_open', label: 'Marketplace' },
  { key: 'card_play_open', label: 'Playing Action Cards' },
];

export default function ControlRoomTab() {
  const [toggles, setToggles] = useState(null);
  const [mayhem, setMayhem] = useState(null);
  const [protections, setProtections] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    const [t, m] = await Promise.all([api.get('/super-admin/toggles'), api.get('/mayhem/current')]);
    setToggles(t);
    setMayhem(m);
    if (m) setProtections(await api.get('/mayhem/protections'));
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
      await api.post('/mayhem/trigger', { requestId: newRequestId() });
      toast('Mayhem triggered!', 'success');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not trigger mayhem.', 'error');
    } finally { setBusy(false); }
  }

  if (!toggles) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <div className="card-surface section">
        <h2>Game Toggles</h2>
        {TOGGLES.map((t) => (
          <div key={t.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
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
        <h2>Market Mayhem</h2>
        {mayhem ? (
          <>
            <h1>{mayhem.title}</h1>
            <p>{mayhem.description}</p>
            <p><b>Effect:</b> {mayhem.effect_text}</p>
            <p>Tags: {mayhem.tags?.join(', ')}</p>
          </>
        ) : (
          <p>No mayhem triggered yet.</p>
        )}
        <button className="btn btn-danger btn-block" disabled={busy} onClick={trigger}>Trigger Random Mayhem</button>
      </div>

      {protections && (
        <div className="card-surface section">
          <h2>Who's Protected</h2>
          <p>Decide manually whether these teams are shielded from the current mayhem.</p>
          <h3 style={{ marginTop: 12 }}>Holding a protecting Special/AI card</h3>
          {protections.specialCardHolders.length === 0 && <p>No team currently holds a protecting Special/AI card.</p>}
          {protections.specialCardHolders.map((p, i) => (
            <p key={i}><b>{p.team_code}</b> — {p.card_name}</p>
          ))}
          <h3 style={{ marginTop: 12 }}>Identity card reacts to this mayhem's tags</h3>
          {protections.taggedIdentityCardHolders.map((p, i) => (
            <p key={i}><b>{p.team_code}</b> — {p.card_title} ({p.category})</p>
          ))}
        </div>
      )}
    </div>
  );
}
