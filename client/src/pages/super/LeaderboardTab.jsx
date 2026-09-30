import { useEffect, useState } from 'react';
import { supabase, call } from '../../lib/supabase.js';

// Resource Score (30%) + Decision Score (70%) + Secret Mission bonus, per the
// Point System doc — same formula the old Express /super-admin/leaderboard
// route computed server-side; moved here since it's pure display math with
// no security stakes, computed from fn_super_leaderboard_raw()'s columns.
function scoreLeaderboard(rows) {
  const scored = rows.map((r) => {
    const x = Math.min(r.cash_l / 10, 10);
    const y = Math.min(r.customers / 20000, 10);
    const cashScore = (x / 10) * 100;
    const customerScore = (y / 10) * 100;
    const reputationScore = (r.reputation / 5) * 100;
    const innovationScore = (r.innovation / 10) * 100;
    const resourceScore = 0.3 * cashScore + 0.3 * customerScore + 0.2 * reputationScore + 0.2 * innovationScore;
    const decisionScore = Math.max(0, Math.min(100, Number(r.decision_points)));
    const missionBonus = r.mission_completed ? Number(r.bonus_points || 0) : 0;
    const total = 0.3 * resourceScore + 0.7 * decisionScore + missionBonus;
    return {
      teamId: r.team_id,
      teamCode: r.team_code,
      decisionPoints: r.decision_points,
      resourceScore: Math.round(resourceScore * 10) / 10,
      decisionScore: Math.round(decisionScore * 10) / 10,
      missionBonus,
      totalScore: Math.round(total * 10) / 10,
    };
  });
  scored.sort((a, b) => b.totalScore - a.totalScore);
  return scored;
}

export default function LeaderboardTab() {
  const [leaderboard, setLeaderboard] = useState([]);

  useEffect(() => {
    call(supabase.rpc('fn_super_leaderboard_raw')).then((rows) => setLeaderboard(scoreLeaderboard(rows)));
  }, []);

  return (
    <div className="card-surface section">
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr><th>#</th><th>Team</th><th>Resource</th><th>Points</th><th>Decision</th><th>Mission</th><th>Total</th></tr>
          </thead>
          <tbody>
            {leaderboard.map((r, i) => (
              <tr key={r.teamId}>
                <td>{i + 1}</td><td><b>{r.teamCode}</b></td><td>{r.resourceScore}</td>
                <td>{r.decisionPoints}</td><td>{r.decisionScore}</td><td>+{r.missionBonus}</td><td><b>{r.totalScore}</b></td>
              </tr>
            ))}
            {leaderboard.length === 0 && (
              <tr><td colSpan={7}>No teams yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
