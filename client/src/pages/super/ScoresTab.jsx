import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export default function ScoresTab() {
  const [leaderboard, setLeaderboard] = useState([]);
  const [points, setPoints] = useState([]);
  const [view, setView] = useState('leaderboard');

  useEffect(() => {
    api.get('/super-admin/leaderboard').then(setLeaderboard);
    api.get('/super-admin/decision-points').then(setPoints);
  }, []);

  return (
    <div>
      <div className="tabbar" style={{ position: 'static' }}>
        <button className={view === 'leaderboard' ? 'active' : ''} onClick={() => setView('leaderboard')}>Leaderboard</button>
        <button className={view === 'points' ? 'active' : ''} onClick={() => setView('points')}>Decision Points</button>
      </div>

      {view === 'leaderboard' && (
        <div className="card-surface section" style={{ marginTop: 16 }}>
          <h2>Hidden Leaderboard (Super Admin only)</h2>
          <p>Resource Score 30% + Decision Score 70% + Secret Mission bonus.</p>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>#</th><th>Team</th><th>Resource</th><th>Decision</th><th>Mission</th><th>Total</th></tr></thead>
              <tbody>
                {leaderboard.map((r, i) => (
                  <tr key={r.teamId}>
                    <td>{i + 1}</td><td>{r.teamCode}</td><td>{r.resourceScore}</td>
                    <td>{r.decisionScore}</td><td>+{r.missionBonus}</td><td><b>{r.totalScore}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === 'points' && (
        <div className="card-surface section" style={{ marginTop: 16 }}>
          <h2>Decision Points</h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Team</th><th>Total</th></tr></thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.team_id}>
                    <td>{p.team_code}</td>
                    <td>{p.decision_points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
