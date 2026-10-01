// Writes every active team's current resources + points into a plain .xlsx
// file — no live DB connection to set up in Excel, no ODBC/pooler config.
// Just run this again whenever you want the sheet's numbers refreshed, or
// pass --watch=<seconds> to have it keep refreshing the same file in place.
//
// Reads one existing super_admin login from credentials.local.csv (never
// printed) to call fn_admin_teams + fn_super_leaderboard_raw over the same
// REST API the app itself uses — no direct Postgres connection needed,
// which is the flaky part on-site. super_admin (not admin) is required
// because decision_points is super_admin-only, same as in the app.
//
// Resource/Decision/Total score columns are computed with the exact same
// formula as the Super Admin's in-app Leaderboard (LeaderboardTab.jsx):
// Total = 30% Resource Score + 70% Decision Score + Mission Bonus.
//
// Usage:
//   node scripts/exportResourcesExcel.js
//   node scripts/exportResourcesExcel.js --watch=30
//   node scripts/exportResourcesExcel.js --out=/path/to/resources.xlsx
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(__dirname, 'credentials.local.csv');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY in server/.env');
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const OUT_PATH = args.out ? path.resolve(args.out) : path.join(__dirname, '..', 'resources.xlsx');
const WATCH_SECONDS = args.watch ? Number(args.watch) : null;

function readFirstSuperAdminCredential() {
  const csv = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  const header = csv[0].split(',');
  const roleIdx = header.indexOf('role');
  const loginIdx = header.indexOf('login_id');
  const passIdx = header.indexOf('password');
  for (const line of csv.slice(1)) {
    const cols = line.split(',');
    if (cols[roleIdx] === 'super_admin') {
      return { login_id: cols[loginIdx], password: cols[passIdx] };
    }
  }
  throw new Error('No super_admin credential row found in credentials.local.csv');
}

// Mirrors LeaderboardTab.jsx's scoreLeaderboard() exactly.
function scoreTeam(r) {
  const x = Math.min(r.cash_l / 10, 10);
  const y = Math.min(r.customers / 20000, 10);
  const cashScore = (x / 10) * 100;
  const customerScore = (y / 10) * 100;
  const reputationScore = (r.reputation / 5) * 100;
  const innovationScore = (r.innovation / 10) * 100;
  const resourceScore = 0.3 * cashScore + 0.3 * customerScore + 0.2 * reputationScore + 0.2 * innovationScore;
  const decisionScore = Math.max(0, Math.min(100, Number(r.decision_points)));
  const missionBonus = r.mission_completed ? Number(r.bonus_points || 0) : 0;
  const totalScore = 0.3 * resourceScore + 0.7 * decisionScore + missionBonus;
  return {
    resourceScore: Math.round(resourceScore * 10) / 10,
    decisionScore: Math.round(decisionScore * 10) / 10,
    missionBonus,
    totalScore: Math.round(totalScore * 10) / 10,
  };
}

async function rpc(fn, body, token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token ?? ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fn} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchTeams() {
  const { login_id, password } = readFirstSuperAdminCredential();
  const login = await rpc('fn_login', { p_role: 'super_admin', p_login_id: login_id, p_password: password });
  if (login.error) throw new Error(`Login failed: ${login.error}`);

  const [teams, leaderboard] = await Promise.all([
    rpc('fn_admin_teams', {}, login.token),
    rpc('fn_super_leaderboard_raw', {}, login.token),
  ]);
  const byId = new Map(leaderboard.map((r) => [r.team_id, r]));

  return teams.map((t) => {
    const lb = byId.get(t.id) || { decision_points: 0, bonus_points: 0, mission_completed: false, mission_title: null };
    return { ...t, ...lb, ...scoreTeam(lb) };
  });
}

async function writeWorkbook(teams) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Resources');
  sheet.columns = [
    { header: 'Team', key: 'team_code', width: 10 },
    { header: 'Market Card', key: 'market_title', width: 24 },
    { header: 'Customer Card', key: 'customer_title', width: 24 },
    { header: 'Cash (₹M)', key: 'cash_m', width: 12 },
    { header: 'Customers', key: 'customers', width: 12 },
    { header: 'Reputation', key: 'reputation', width: 12 },
    { header: 'Innovation', key: 'innovation', width: 12 },
    { header: 'R1 Replacements Used', key: 'replacements_used', width: 20 },
    { header: 'Mission', key: 'mission_title', width: 22 },
    { header: 'Mission Completed', key: 'mission_completed', width: 18 },
    { header: 'Decision Points (raw)', key: 'decision_points', width: 20 },
    { header: 'Resource Score', key: 'resourceScore', width: 16 },
    { header: 'Decision Score', key: 'decisionScore', width: 16 },
    { header: 'Mission Bonus', key: 'missionBonus', width: 14 },
    { header: 'Total Score', key: 'totalScore', width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const t of teams) {
    sheet.addRow({
      team_code: t.team_code,
      market_title: t.market_title,
      customer_title: t.customer_title,
      cash_m: t.cash_l / 10,
      customers: t.customers,
      reputation: t.reputation,
      innovation: t.innovation,
      replacements_used: t.replacements_used,
      mission_title: t.mission_title,
      mission_completed: t.mission_completed ? 'Yes' : 'No',
      decision_points: t.decision_points,
      resourceScore: t.resourceScore,
      decisionScore: t.decisionScore,
      missionBonus: t.missionBonus,
      totalScore: t.totalScore,
    });
  }
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: sheet.columns.length } };

  await wb.xlsx.writeFile(OUT_PATH);
  console.log(`Updated ${OUT_PATH} — ${teams.length} teams, ${new Date().toLocaleTimeString()}`);
}

async function runOnce() {
  const teams = await fetchTeams();
  await writeWorkbook(teams);
}

async function main() {
  await runOnce();
  if (WATCH_SECONDS) {
    console.log(`Watching — refreshing every ${WATCH_SECONDS}s. Ctrl+C to stop.`);
    setInterval(() => {
      runOnce().catch((err) => console.error('Refresh failed:', err.message));
    }, WATCH_SECONDS * 1000);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
