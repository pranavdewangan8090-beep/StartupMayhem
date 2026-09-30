import { useEffect, useState } from 'react';
import { supabase, call, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';
import Modal from '../../components/Modal.jsx';

export default function TeamManagementTab() {
  const [teams, setTeams] = useState([]);
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [credential, setCredential] = useState(null); // { teamCode|loginId, password }
  const toast = useToast();

  async function load() {
    setTeams(await call(supabase.rpc('fn_admin_teams')));
  }
  useEffect(() => { load(); }, []);

  async function addTeam() {
    if (!newCode.trim()) return;
    setBusy(true);
    try {
      const result = await call(supabase.rpc('fn_super_add_team', { p_team_code: newCode.trim() }));
      setCredential(result);
      setNewCode('');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add team.', 'error');
    } finally { setBusy(false); }
  }

  async function deactivate(teamId) {
    setBusy(true);
    try {
      await call(supabase.rpc('fn_super_deactivate_team', { p_team_id: teamId }));
      toast('Team deactivated.', 'info');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not deactivate.', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="card-surface section">
        <div className="admin-card-head"><h2>Add a Team</h2></div>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Team Code</label>
            <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="T31" />
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={addTeam}>Add</button>
        </div>
      </div>

      <div className="card-surface section">
        <div className="admin-card-head">
          <h2>Teams</h2>
          <span className="admin-card-hint">{teams.length} active</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Team</th><th>Market</th><th>Customer</th><th /></tr></thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.team_code}</b></td>
                  <td>{t.market_title}</td>
                  <td>{t.customer_title}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="icon-btn" disabled={busy} onClick={() => deactivate(t.id)} title="Deactivate team" aria-label="Deactivate team">✕</button>
                  </td>
                </tr>
              ))}
              {teams.length === 0 && (
                <tr><td colSpan={4}>No teams yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {credential && (
        <Modal onClose={() => setCredential(null)}>
          <h2>Team Created — {credential.teamCode}</h2>
          <p>Give this to the team — it will not be shown again.</p>
          <p>Login ID: <b>{credential.loginId}</b></p>
          <p>Password: <b>{credential.password}</b></p>
        </Modal>
      )}
    </div>
  );
}
