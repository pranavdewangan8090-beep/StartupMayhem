import { useEffect, useState } from 'react';
import { supabase, call, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';
import Modal from '../../components/Modal.jsx';
import ConfirmModal from '../../components/ConfirmModal.jsx';

const ROLE_LABEL = { admin: 'Admin', super_admin: 'Super Admin' };

export default function TeamManagementTab() {
  const [accounts, setAccounts] = useState([]);
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [credential, setCredential] = useState(null); // { heading, loginId, password }
  const [pending, setPending] = useState(null); // { kind: 'deactivate'|'reactivate'|'reset', account }
  const toast = useToast();

  async function load() {
    try {
      setAccounts(await call(supabase.rpc('fn_super_accounts')));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load accounts.', 'error');
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const teams = accounts.filter((a) => a.role === 'player');
  const staff = accounts.filter((a) => a.role !== 'player');
  const activeCount = teams.filter((t) => t.team_active).length;

  async function addTeam() {
    if (!newCode.trim()) return;
    setBusy(true);
    try {
      const result = await call(supabase.rpc('fn_super_add_team', { p_team_code: newCode.trim() }));
      setCredential({ heading: `Team Created — ${result.teamCode}`, loginId: result.loginId, password: result.password });
      setNewCode('');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add team.', 'error');
    } finally { setBusy(false); }
  }

  async function runPending() {
    const { kind, account } = pending;
    setBusy(true);
    try {
      if (kind === 'deactivate') {
        await call(supabase.rpc('fn_super_deactivate_team', { p_team_id: account.team_id }));
        toast(`${account.team_code} deactivated.`, 'info');
      } else if (kind === 'reactivate') {
        await call(supabase.rpc('fn_super_reactivate_team', { p_team_id: account.team_id }));
        toast(`${account.team_code} reactivated.`, 'success');
      } else {
        const result = await call(supabase.rpc('fn_super_reset_password', { p_user_id: account.user_id }));
        setCredential({
          heading: `New password — ${account.team_code || result.loginId}`,
          loginId: result.loginId,
          password: result.password,
        });
      }
      setPending(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not complete that action.', 'error');
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
          <span className="admin-card-hint">{activeCount} active</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Team</th><th>Login ID</th><th>Market</th><th>Customer</th><th /></tr></thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.user_id} style={t.team_active ? undefined : { opacity: 0.55 }}>
                  <td><b>{t.team_code}</b>{!t.team_active && ' (inactive)'}</td>
                  <td>{t.login_id}</td>
                  <td>{t.market_title}</td>
                  <td>{t.customer_title}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPending({ kind: 'reset', account: t })}>
                      Reset password
                    </button>{' '}
                    {t.team_active ? (
                      <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => setPending({ kind: 'deactivate', account: t })}>
                        Deactivate
                      </button>
                    ) : (
                      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setPending({ kind: 'reactivate', account: t })}>
                        Reactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {teams.length === 0 && (
                <tr><td colSpan={5}>No teams yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card-surface section">
        <div className="admin-card-head"><h2>Staff Accounts</h2></div>
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Login ID</th><th>Role</th><th /></tr></thead>
            <tbody>
              {staff.map((a) => (
                <tr key={a.user_id} style={a.user_active ? undefined : { opacity: 0.55 }}>
                  <td><b>{a.login_id}</b>{!a.user_active && ' (inactive)'}</td>
                  <td>{ROLE_LABEL[a.role]}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPending({ kind: 'reset', account: a })}>
                      Reset password
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {pending?.kind === 'deactivate' && (
        <ConfirmModal title={`Deactivate ${pending.account.team_code}?`} confirmLabel="Deactivate" danger busy={busy} onConfirm={runPending} onCancel={() => setPending(null)}>
          <p>The team is logged out immediately, drops off the leaderboard, is skipped by any crisis triggered while inactive, and every pending deal involving it is withdrawn.</p>
          <p>You can reactivate it later from this list.</p>
        </ConfirmModal>
      )}
      {pending?.kind === 'reactivate' && (
        <ConfirmModal title={`Reactivate ${pending.account.team_code}?`} confirmLabel="Reactivate" busy={busy} onConfirm={runPending} onCancel={() => setPending(null)}>
          <p>The team can log in again with its existing password. Any crisis triggered while it was inactive was <b>not</b> applied to it — adjust its resources manually from the Teams tab if needed.</p>
        </ConfirmModal>
      )}
      {pending?.kind === 'reset' && (
        <ConfirmModal
          title={`Reset password for ${pending.account.team_code || pending.account.login_id}?`}
          confirmLabel="Reset password"
          busy={busy}
          onConfirm={runPending}
          onCancel={() => setPending(null)}
        >
          <p>A new 6-digit PIN is generated and shown once. Anyone currently logged in to this account is logged out.</p>
        </ConfirmModal>
      )}

      {credential && (
        <Modal onClose={() => setCredential(null)}>
          <h2>{credential.heading}</h2>
          <p>Give this to the account holder — it will not be shown again.</p>
          <p>Login ID: <b>{credential.loginId}</b></p>
          <p>Password: <b>{credential.password}</b></p>
        </Modal>
      )}
    </div>
  );
}
