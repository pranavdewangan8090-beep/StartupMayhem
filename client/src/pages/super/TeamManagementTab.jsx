import { useEffect, useState } from 'react';
import { supabase, call, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';
import Modal from '../../components/Modal.jsx';
import ConfirmModal from '../../components/ConfirmModal.jsx';

const ROLE_LABEL = { admin: 'Admin', super_admin: 'Super Admin' };

export default function TeamManagementTab() {
  const [accounts, setAccounts] = useState([]);
  const [teamResources, setTeamResources] = useState([]); // fn_admin_teams() — for the merge preview
  const [merges, setMerges] = useState([]);
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [credential, setCredential] = useState(null); // { heading, loginId, password }
  const [pending, setPending] = useState(null); // { kind: 'deactivate'|'reactivate'|'reset', account }
  const [mergeAId, setMergeAId] = useState('');
  const [mergeBId, setMergeBId] = useState('');
  const [confirmMerge, setConfirmMerge] = useState(false);
  const toast = useToast();

  async function load() {
    try {
      const [acc, res, mg] = await Promise.all([
        call(supabase.rpc('fn_super_accounts')),
        call(supabase.rpc('fn_admin_teams')),
        call(supabase.rpc('fn_super_team_merges')),
      ]);
      setAccounts(acc);
      setTeamResources(res);
      setMerges(mg);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load accounts.', 'error');
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const teams = accounts.filter((a) => a.role === 'player');
  const staff = accounts.filter((a) => a.role !== 'player');
  const activeCount = teams.filter((t) => t.team_active).length;
  // one option per distinct active team, even though a merged team can have
  // two account rows sharing the same team_id
  const activeTeamOptions = [...new Map(teams.filter((t) => t.team_active).map((t) => [t.team_id, t])).values()]
    .sort((a, b) => a.team_code.localeCompare(b.team_code));

  const teamA = teamResources.find((t) => String(t.id) === String(mergeAId));
  const teamB = teamResources.find((t) => String(t.id) === String(mergeBId));
  const avg = (a, b) => Math.round((Number(a) + Number(b)) / 2);

  async function runMerge() {
    setBusy(true);
    try {
      const result = await call(supabase.rpc('fn_super_merge_teams', { p_team_a_id: Number(mergeAId), p_team_b_id: Number(mergeBId) }));
      toast(`Merged ${result.teamACode} + ${result.teamBCode} into ${result.teamCode}.`, 'success');
      setConfirmMerge(false);
      setMergeAId('');
      setMergeBId('');
      await load();
    } catch (err) {
      setConfirmMerge(false);
      toast(err instanceof ApiError ? err.message : 'Could not merge those teams.', 'error');
    } finally { setBusy(false); }
  }

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
        <div className="admin-card-head"><h2>Merge Two Teams (Round 5)</h2></div>
        <p className="admin-card-hint">
          Every resource (Cash, Customers, Reputation, Innovation, Decision Points) is averaged. The merged team
          keeps Team A's identity cards and both teams' Special/Deal/Action cards. Both teams' existing logins keep
          working afterward — they'll both see the merged team. The two original teams are removed; this can't be undone.
        </p>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Team A</label>
            <select value={mergeAId} onChange={(e) => setMergeAId(e.target.value)}>
              <option value="">Select team…</option>
              {activeTeamOptions.map((t) => <option key={t.team_id} value={t.team_id}>{t.team_code}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Team B</label>
            <select value={mergeBId} onChange={(e) => setMergeBId(e.target.value)}>
              <option value="">Select team…</option>
              {activeTeamOptions.map((t) => <option key={t.team_id} value={t.team_id}>{t.team_code}</option>)}
            </select>
          </div>
          <button
            className="btn btn-danger"
            disabled={busy || !mergeAId || !mergeBId || mergeAId === mergeBId}
            onClick={() => setConfirmMerge(true)}
          >
            Merge
          </button>
        </div>

        {merges.length > 0 && (
          <div className="table-scroll" style={{ marginTop: 16 }}>
            <table className="data-table">
              <thead><tr><th>Merged Team</th><th>From</th><th>Merged By</th><th>When</th></tr></thead>
              <tbody>
                {merges.map((m) => (
                  <tr key={m.id}>
                    <td><b>{m.merged_team_code}</b></td>
                    <td>{m.team_a_code} + {m.team_b_code}</td>
                    <td>{m.merged_by_login || '—'}</td>
                    <td>{new Date(m.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

      {confirmMerge && teamA && teamB && (
        <ConfirmModal title={`Merge ${teamA.team_code} + ${teamB.team_code}?`} confirmLabel="Merge teams" danger busy={busy} onConfirm={runMerge} onCancel={() => setConfirmMerge(false)}>
          <p>The merged team will start with:</p>
          <div className="grid-2" style={{ marginBottom: 12 }}>
            <div className="stat-tile"><div className="value">₹{avg(teamA.cash_l, teamB.cash_l) / 10}M</div><div className="label">Cash</div></div>
            <div className="stat-tile"><div className="value">{(avg(teamA.customers, teamB.customers) / 1000).toFixed(0)}k</div><div className="label">Customers</div></div>
            <div className="stat-tile"><div className="value">{avg(teamA.reputation, teamB.reputation)}/5</div><div className="label">Reputation</div></div>
            <div className="stat-tile"><div className="value">{avg(teamA.innovation, teamB.innovation)}/10</div><div className="label">Innovation</div></div>
          </div>
          <p className="warning-text">{teamA.team_code} and {teamB.team_code} are permanently removed, along with their trade/crisis history. This cannot be undone.</p>
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
