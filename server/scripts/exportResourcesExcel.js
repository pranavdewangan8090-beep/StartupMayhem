// Writes every active team's current resources into a plain .xlsx file —
// no live DB connection to set up in Excel, no ODBC/pooler config. Just run
// this again whenever you want the sheet's numbers refreshed, or pass
// --watch=<seconds> to have it keep refreshing the same file in place.
//
// Reads one existing admin login from credentials.local.csv (never printed)
// to call fn_admin_teams over the same REST API the app itself uses — no
// direct Postgres connection needed, which is the flaky part on-site.
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

function readFirstAdminCredential() {
  const csv = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  const header = csv[0].split(',');
  const roleIdx = header.indexOf('role');
  const loginIdx = header.indexOf('login_id');
  const passIdx = header.indexOf('password');
  for (const line of csv.slice(1)) {
    const cols = line.split(',');
    if (cols[roleIdx] === 'admin') {
      return { login_id: cols[loginIdx], password: cols[passIdx] };
    }
  }
  throw new Error('No admin credential row found in credentials.local.csv');
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
  const { login_id, password } = readFirstAdminCredential();
  const login = await rpc('fn_login', { p_role: 'admin', p_login_id: login_id, p_password: password });
  if (login.error) throw new Error(`Login failed: ${login.error}`);
  return rpc('fn_admin_teams', {}, login.token);
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
    { header: 'Mission Completed', key: 'mission_completed', width: 18 },
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
      mission_completed: t.mission_completed ? 'Yes' : 'No',
    });
  }

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
