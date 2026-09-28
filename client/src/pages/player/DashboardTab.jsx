import { useEffect, useState } from 'react';
import { supabase, call } from '../../lib/supabase.js';

const STATUS_LABEL = { pending: 'Awaiting response', used_card: 'Protected — used action card', traded: 'Protected — traded for a card', penalized: 'Penalized' };

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
          <h2>Active Crises</h2>
          {crises.map((c) => (
            <div key={c.crisis_id} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border-color, #333)' }}>
              <h3>{c.title}</h3>
              <p>{c.description}</p>
              <p><b>Useful action cards:</b> {c.useful_card_names?.length ? c.useful_card_names.join(', ') : 'None listed'}</p>
              <p><b>Affected teams:</b> {c.affected_team_codes?.length ? c.affected_team_codes.join(', ') : 'None yet'}</p>
              {c.is_affected ? (
                <p className={c.my_status === 'penalized' ? 'warning-text' : 'success-text'}>
                  Your team is affected — status: {STATUS_LABEL[c.my_status] || 'Awaiting response'}.
                  {c.my_status === 'pending' && ' If you don’t have a useful action card, try trading with another team, then see an admin.'}
                </p>
              ) : (
                <p>Your team is not on the affected list for this crisis.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
