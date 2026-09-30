import { useEffect, useState } from 'react';
import { supabase, call, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';

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

export default function CrisesTab() {
  const [crises, setCrises] = useState([]);
  const [selectedCrisisId, setSelectedCrisisId] = useState(null);
  const [crisisEffects, setCrisisEffects] = useState([]);
  const toast = useToast();

  async function load(currentSelected) {
    try {
      const cr = await call(supabase.rpc('fn_admin_crisis_list'));
      setCrises(cr);
      const firstTriggered = cr.find((c) => c.is_triggered)?.id ?? null;
      const nextSelected = currentSelected ?? firstTriggered;
      setSelectedCrisisId(nextSelected);
      if (nextSelected) await loadCrisisDetail(nextSelected);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load crises.', 'error');
    }
  }

  useEffect(() => {
    load(selectedCrisisId);
    // Polls so a crisis triggered by the Super Admin shows up here live,
    // without the plain Admin having to refresh the page.
    const id = setInterval(() => load(selectedCrisisId), 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCrisisId]);

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

  const triggeredCrises = crises.filter((c) => c.is_triggered);
  const selectedCrisis = crises.find((c) => c.id === selectedCrisisId);

  if (triggeredCrises.length === 0) {
    return <div className="card-surface section"><p>No crisis has been triggered yet.</p></div>;
  }

  return (
    <div>
      {triggeredCrises.length > 1 && (
        <div className="card-surface section">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {triggeredCrises.map((c) => (
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
      )}

      {selectedCrisis && (
        <div className="card-surface section">
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
    </div>
  );
}
