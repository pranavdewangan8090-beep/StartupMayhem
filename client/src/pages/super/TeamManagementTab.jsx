import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { useToast } from '../../lib/ToastContext.jsx';
import Modal from '../../components/Modal.jsx';

export default function TeamManagementTab() {
  const [teams, setTeams] = useState([]);
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [credential, setCredential] = useState(null); // { teamCode|loginId, password }
  const toast = useToast();

  async function load() {
    setTeams(await api.get('/admin/teams'));
  }
  useEffect(() => { load(); }, []);

  async function addTeam() {
    if (!newCode.trim()) return;
    setBusy(true);
    try {
      const result = await api.post('/super-admin/teams', { teamCode: newCode.trim() });
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
      await api.post(`/super-admin/teams/${teamId}/deactivate`, {});
      toast('Team deactivated.', 'info');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not deactivate.', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="card-surface section">
        <h2>Add a Team</h2>
        <div className="field">
          <label>Team Code</label>
          <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="T31" />
        </div>
        <button className="btn btn-primary btn-block" disabled={busy} onClick={addTeam}>Add Team</button>
      </div>

      <div className="card-surface section">
        <h2>Teams</h2>
        {teams.map((t) => (
          <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <span>{t.team_code}</span>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => deactivate(t.id)}>Deactivate</button>
          </div>
        ))}
      </div>

      {credential && (
        <Modal onClose={() => setCredential(null)}>
          <h2>Team Created</h2>
          <p>Give this to the team — it will not be shown again.</p>
          <p><b>{credential.teamCode}</b> / <b>{credential.password}</b></p>
        </Modal>
      )}
    </div>
  );
}
