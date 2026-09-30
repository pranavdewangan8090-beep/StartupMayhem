import { useEffect, useState } from 'react';
import { supabase, call } from '../../lib/supabase.js';

const TIER_LABEL = { hit_hard: 'Hit Hard', hit: 'Hit', unaffected: 'Unaffected', gains: 'Gains' };
const TIER_ROWS = [
  ['hit_hard', 'Hit Hard', 'hit_hard_teams'],
  ['hit', 'Hit', 'hit_teams'],
  ['gains', 'Gains', 'gains_teams'],
  ['unaffected', 'Unaffected', 'unaffected_teams'],
];

function formatDelta(applied) {
  if (!applied) return null;
  const parts = [];
  if (applied.cash_l) parts.push(`${applied.cash_l > 0 ? '+' : ''}₹${applied.cash_l / 10}M Cash`);
  if (applied.customers) parts.push(`${applied.customers > 0 ? '+' : ''}${applied.customers / 1000}k Customers`);
  if (applied.reputation) parts.push(`${applied.reputation > 0 ? '+' : ''}${applied.reputation} Reputation`);
  if (applied.innovation) parts.push(`${applied.innovation > 0 ? '+' : ''}${applied.innovation} Innovation`);
  return parts.length ? parts.join(' · ') : 'No change';
}

export default function DashboardTab() {
  const [status, setStatus] = useState(null);
  const [crises, setCrises] = useState([]);

  useEffect(() => {
    call(supabase.rpc('fn_player_status')).then((rows) => setStatus(rows?.[0]));
    call(supabase.rpc('fn_crisis_public')).then(setCrises);
  }, []);

  if (!status) return <div className="empty-state">Loading company status…</div>;

  return (
    <div>
      <div className="card-surface section">
        <h2>Company Status</h2>
        <div className="grid-2">
          <div className="stat-tile"><div className="value">₹{status.cash_l / 10}M</div><div className="label">Cash</div></div>
          <div className="stat-tile"><div className="value">{(status.customers / 1000).toFixed(0)}k</div><div className="label">Customers</div></div>
          <div className="stat-tile"><div className="value">{status.reputation}/5</div><div className="label">Reputation</div></div>
          <div className="stat-tile"><div className="value">{status.innovation}/10</div><div className="label">Innovation</div></div>
        </div>
      </div>

      {crises.length > 0 && (
        <div className="card-surface section">
          <h2>Crises</h2>
          {crises.map((c) => (
            <div key={c.crisis_id} className="crisis-entry">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{c.title}</h3>
                {c.tier && <span className={`pill tier-${c.tier}`}>{TIER_LABEL[c.tier]}</span>}
              </div>
              <p>{c.description}</p>
              {c.tier && (
                <p className={c.tier === 'hit_hard' || c.tier === 'hit' ? 'warning-text' : 'success-text'}>
                  Effect on your company: {formatDelta(c.applied)}
                </p>
              )}
              {TIER_ROWS.map(([tier, label, key]) => (
                c[key]?.length > 0 && (
                  <p key={tier} className="mayhem-affected-row">
                    <span className={`pill tier-${tier}`}>{label}</span> {c[key].join(', ')}
                  </p>
                )
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
