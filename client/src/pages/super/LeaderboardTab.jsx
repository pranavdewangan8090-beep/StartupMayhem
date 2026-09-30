import { useEffect, useState } from 'react';
import { supabase, call, ApiError } from '../../lib/supabase.js';
import { useToast } from '../../lib/ToastContext.jsx';

// Total = Resource Score (100%) + Secret Mission bonus. Decision Points
// were removed from scoring entirely — they were a hidden, crisis-driven
// number nobody could see the reasoning behind, so the game no longer
// tracks or displays them. Resource Score itself is unchanged: 30% Cash +
// 30% Customers + 20% Reputation + 20% Innovation, each already scaled
// 0-100 with the same caps as before (₹10M cash, 200k customers).
function scoreLeaderboard(rows) {
  const scored = rows.map((r) => {
    const x = Math.min(r.cash_l / 10, 10);
    const y = Math.min(r.customers / 20000, 10);
    const cashScore = (x / 10) * 100;
    const customerScore = (y / 10) * 100;
    const reputationScore = (r.reputation / 5) * 100;
    const innovationScore = (r.innovation / 10) * 100;
    const resourceScore = 0.3 * cashScore + 0.3 * customerScore + 0.2 * reputationScore + 0.2 * innovationScore;
    const missionBonus = r.mission_completed ? Number(r.bonus_points || 0) : 0;
    const total = resourceScore + missionBonus;
    return {
      teamId: r.team_id,
      teamCode: r.team_code,
      missionTitle: r.mission_title,
      missionCompleted: r.mission_completed,
      bonusPoints: Number(r.bonus_points || 0),
      resourceScore: Math.round(resourceScore * 10) / 10,
      missionBonus,
      totalScore: Math.round(total * 10) / 10,
    };
  });
  scored.sort((a, b) => b.totalScore - a.totalScore);
  return scored;
}

export default function LeaderboardTab() {
  const [leaderboard, setLeaderboard] = useState([]);
  const [busyTeamId, setBusyTeamId] = useState(null);
  const toast = useToast();

  async function load() {
    try {
      setLeaderboard(scoreLeaderboard(await call(supabase.rpc('fn_super_leaderboard_raw'))));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the leaderboard.', 'error');
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Secret Missions are judged by the GMs; this is where the verdict is
  // recorded (fn_super_mark_mission previously had no UI at all).
  async function setMission(row, completed) {
    setBusyTeamId(row.teamId);
    try {
      await call(supabase.rpc('fn_super_mark_mission', { p_team_id: row.teamId, p_completed: completed }));
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update the mission.', 'error');
    } finally { setBusyTeamId(null); }
  }

  return (
    <div className="card-surface section">
      <div className="admin-card-head">
        <h2>Standings</h2>
        <button className="btn btn-ghost btn-sm" onClick={load}>Refresh</button>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr><th>#</th><th>Team</th><th>Resource</th><th>Secret Mission</th><th>Total</th></tr>
          </thead>
          <tbody>
            {leaderboard.map((r, i) => (
              <tr key={r.teamId}>
                <td>{i + 1}</td><td><b>{r.teamCode}</b></td><td>{r.resourceScore}</td>
                <td>
                  <div>{r.missionTitle} (+{r.bonusPoints})</div>
                  <button
                    className={`btn btn-sm ${r.missionCompleted ? 'btn-success' : 'btn-ghost'}`}
                    disabled={busyTeamId === r.teamId}
                    onClick={() => setMission(r, !r.missionCompleted)}
                    title={r.missionCompleted ? 'Click to undo' : 'Mark this mission as completed'}
                  >
                    {r.missionCompleted ? 'Completed ✓' : 'Mark complete'}
                  </button>
                </td>
                <td><b>{r.totalScore}</b></td>
              </tr>
            ))}
            {leaderboard.length === 0 && (
              <tr><td colSpan={5}>No teams yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
