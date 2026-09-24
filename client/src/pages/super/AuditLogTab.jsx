import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export default function AuditLogTab() {
  const [log, setLog] = useState([]);
  useEffect(() => { api.get('/super-admin/audit-log').then(setLog); }, []);

  return (
    <div className="card-surface section">
      <h2>Audit Log</h2>
      <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {log.map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.created_at).toLocaleString()}</td>
                <td>{l.role} #{l.login_id}</td>
                <td>{l.action}</td>
                <td style={{ maxWidth: 260, overflowWrap: 'anywhere' }}>{JSON.stringify(l.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
