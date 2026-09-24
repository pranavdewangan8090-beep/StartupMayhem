import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export default function DashboardTab({ gameState }) {
  const [status, setStatus] = useState(null);
  const [mayhem, setMayhem] = useState(null);
  const [notifications, setNotifications] = useState([]);

  async function load() {
    const [s, m, n] = await Promise.all([
      api.get('/player/status'),
      api.get('/mayhem/current'),
      api.get('/player/notifications'),
    ]);
    setStatus(s);
    setMayhem(m);
    setNotifications(n);
  }

  useEffect(() => { load(); }, [gameState?.current_mayhem_event_id, gameState?.unread_notifications]);

  useEffect(() => {
    if (notifications.some((n) => !n.read_at)) {
      api.post('/player/notifications/read').catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications]);

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

      {mayhem && (
        <div className="card-surface section" style={{ borderColor: 'var(--danger)' }}>
          <span className="pill" style={{ background: 'rgba(239,68,68,0.2)', color: 'var(--danger)' }}>⚡ Market Mayhem</span>
          <h2 style={{ marginTop: 8 }}>{mayhem.title}</h2>
          <p>{mayhem.description}</p>
          <p><b>Effect:</b> {mayhem.effect_text}</p>
        </div>
      )}

      <div className="card-surface section">
        <h2>Notifications</h2>
        {notifications.length === 0 && <p>Nothing yet.</p>}
        {notifications.map((n) => (
          <div key={n.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 700 }}>{n.title}</div>
            {n.body && <p>{n.body}</p>}
            <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>{new Date(n.created_at).toLocaleTimeString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
