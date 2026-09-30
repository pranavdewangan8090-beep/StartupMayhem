import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { supabase, call, ApiError } from '../lib/supabase.js';
import { useToast } from '../lib/ToastContext.jsx';

export default function TeamResourcePanel() {
  const [teams, setTeams] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    setTeams(await call(supabase.rpc('fn_admin_teams')));
  }
  useEffect(() => { load(); }, []);

  function openResourceModal(team) {
    setForm({ dCashL: 0, dCustomers: 0, dReputation: 0, dInnovation: 0 });
    setModal({ team, mode: 'resources' });
  }

  async function submitResources() {
    setBusy(true);
    try {
      await call(supabase.rpc('fn_admin_adjust_resources', {
        p_team_id: modal.team.id,
        p_delta: {
          cash_l: Number(form.dCashL) || 0,
          customers: Number(form.dCustomers) || 0,
          reputation: Number(form.dReputation) || 0,
          innovation: Number(form.dInnovation) || 0,
        },
      }));
      toast('Resources updated.', 'success');
      setModal(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update resources.', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="teams-grid">
        {teams.map((t) => (
          <div key={t.id} className="card-surface section team-card">
            <h2>{t.team_code}</h2>
            <p>{t.market_title} · {t.customer_title}</p>
            <div className="grid-2" style={{ marginBottom: 12 }}>
              <div className="stat-tile"><div className="value">₹{t.cash_l / 10}M</div><div className="label">Cash</div></div>
              <div className="stat-tile"><div className="value">{(t.customers / 1000).toFixed(0)}k</div><div className="label">Customers</div></div>
              <div className="stat-tile"><div className="value">{t.reputation}/5</div><div className="label">Reputation</div></div>
              <div className="stat-tile"><div className="value">{t.innovation}/10</div><div className="label">Innovation</div></div>
            </div>
            <div className="row" style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={() => openResourceModal(t)}>Adjust Resources</button>
            </div>
          </div>
        ))}
      </div>

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
          <button className="btn btn-primary btn-block" disabled={busy} onClick={submitResources}>Apply</button>
        </Modal>
      )}
    </div>
  );
}
