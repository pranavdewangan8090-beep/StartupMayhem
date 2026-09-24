import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api, newRequestId, ApiError } from '../lib/api.js';
import { useToast } from '../lib/ToastContext.jsx';

const ROUNDS = [
  { n: 1, label: 'R1 Idea Lab (/10)' },
  { n: 2, label: 'R2 Build & Battle (/15)' },
  { n: 3, label: 'R3 Market Mayhem (/15)' },
  { n: 4, label: 'R4 Funding War (/15)' },
  { n: 5, label: 'R5 Big Negotiation (/15)' },
  { n: 6, label: 'R6 Final Pitch (/30)' },
];

/**
 * Shared by both the Admin and Super Admin panels: the team list plus the
 * resource-adjustment and decision-points modals. Both roles hit the same
 * /api/admin/* endpoints — the server enforces the finer-grained differences.
 */
export default function TeamResourcePanel() {
  const [teams, setTeams] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    setTeams(await api.get('/admin/teams'));
  }
  useEffect(() => { load(); }, []);

  function openResourceModal(team) {
    setForm({ dCashL: 0, dCustomers: 0, dReputation: 0, dInnovation: 0, reason: '' });
    setModal({ team, mode: 'resources' });
  }
  function openPointsModal(team) {
    setForm({ round: 1, delta: 0, note: '' });
    setModal({ team, mode: 'points' });
  }

  async function submitResources() {
    setBusy(true);
    try {
      await api.post('/admin/resources/adjust', {
        teamId: modal.team.id,
        dCashL: Number(form.dCashL) || 0,
        dCustomers: Number(form.dCustomers) || 0,
        dReputation: Number(form.dReputation) || 0,
        dInnovation: Number(form.dInnovation) || 0,
        reason: form.reason || '(no reason given)',
        requestId: newRequestId(),
      });
      toast('Resources updated.', 'success');
      setModal(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update resources.', 'error');
    } finally { setBusy(false); }
  }

  async function submitPoints() {
    const delta = Number(form.delta);
    if (!delta) { toast('Delta cannot be zero.', 'error'); return; }
    setBusy(true);
    try {
      await api.post('/admin/decision-points/adjust', {
        teamId: modal.team.id,
        round: Number(form.round),
        delta,
        note: form.note || '',
        requestId: newRequestId(),
      });
      toast('Decision points recorded.', 'success');
      setModal(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not record points.', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="card-surface section">
        <h1>Teams</h1>
        <p>Adjust resources or decision points. Every change is logged with your name, the reason and a before/after snapshot.</p>
      </div>

      {teams.map((t) => (
        <div key={t.id} className="card-surface section">
          <h2>{t.team_code}</h2>
          <p>{t.market_title} · {t.customer_title} · {t.problem_title}</p>
          <div className="grid-2" style={{ marginBottom: 12 }}>
            <div className="stat-tile"><div className="value">₹{t.cash_l / 10}M</div><div className="label">Cash</div></div>
            <div className="stat-tile"><div className="value">{(t.customers / 1000).toFixed(0)}k</div><div className="label">Customers</div></div>
            <div className="stat-tile"><div className="value">{t.reputation}/5</div><div className="label">Reputation</div></div>
            <div className="stat-tile"><div className="value">{t.innovation}/10</div><div className="label">Innovation</div></div>
          </div>
          <div className="row" style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={() => openResourceModal(t)}>Adjust Resources</button>
            <button className="btn btn-ghost btn-sm" onClick={() => openPointsModal(t)}>Decision Points</button>
          </div>
        </div>
      ))}

      {modal?.mode === 'resources' && (
        <Modal onClose={() => setModal(null)}>
          <h2>Adjust {modal.team.team_code}'s Resources</h2>
          <p>Enter deltas (positive to add, negative to subtract). Caps and floors are applied automatically.</p>
          {[
            ['dCashL', 'Δ Cash (in ₹ lakhs, 10 = ₹1M)'],
            ['dCustomers', 'Δ Customers'],
            ['dReputation', 'Δ Reputation (max 5)'],
            ['dInnovation', 'Δ Innovation (max 10)'],
          ].map(([key, label]) => (
            <div className="field" key={key}>
              <label>{label}</label>
              <input type="number" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
            </div>
          ))}
          <div className="field">
            <label>Reason (required — shown in the audit log)</label>
            <textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
          <button className="btn btn-primary btn-block" disabled={busy} onClick={submitResources}>Apply</button>
        </Modal>
      )}

      {modal?.mode === 'points' && (
        <Modal onClose={() => setModal(null)}>
          <h2>Decision Points — {modal.team.team_code}</h2>
          <p>Players never see this. Only the Super Admin can view every team's points.</p>
          <div className="field">
            <label>Round</label>
            <select value={form.round} onChange={(e) => setForm({ ...form, round: e.target.value })}>
              {ROUNDS.map((r) => <option key={r.n} value={r.n}>{r.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Δ Points</label>
            <input type="number" value={form.delta} onChange={(e) => setForm({ ...form, delta: e.target.value })} />
          </div>
          <div className="field">
            <label>Note</label>
            <textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          <button className="btn btn-primary btn-block" disabled={busy} onClick={submitPoints}>Save</button>
        </Modal>
      )}
    </div>
  );
}
