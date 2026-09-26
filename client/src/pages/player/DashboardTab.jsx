import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export default function DashboardTab() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    api.get('/player/status').then(setStatus);
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
    </div>
  );
}
