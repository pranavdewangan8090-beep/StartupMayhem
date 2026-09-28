// Minimal PostgREST client for integration-testing the real Supabase project
// directly — there is no server to start first. Every RPC call goes exactly
// where the browser's lib/supabase.js sends it: POST
// {SUPABASE_URL}/rest/v1/rpc/{fn_name} with the caller's JWT (or the anon key,
// pre-login) as the Bearer token.
//
// Safety model: these tests run against the real Supabase project named in
// .env. To avoid disturbing real teams' state, every test that needs to
// mutate game data creates its own disposable team via fn_super_add_team and
// deletes it afterward in fn_super_add_team, instead of touching one of the
// real seeded teams. Toggle flips are captured and restored. Market Mayhem
// trigger/respond are read-only-tested only — see mayhem.test.js.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in server/.env to run the test suite.');
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** One authenticated (or anonymous) caller. */
export class Session {
  constructor() {
    this.token = null;
    this.role = null;
    this.teamId = null;
  }

  async rpc(fnName, args = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ANON_KEY,
        Authorization: `Bearer ${this.token || ANON_KEY}`,
      },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new ApiError((data?.message || res.statusText || '').trim(), res.status);
    }
    return data;
  }

  async login(role, loginId, password) {
    const result = await this.rpc('fn_login', { p_role: role, p_login_id: loginId, p_password: password });
    this.token = result.token;
    this.role = result.role;
    this.teamId = result.teamId;
    return result;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(__dirname, '..', 'scripts', 'credentials.local.csv');

/** Reads the real seeded accounts written by scripts/seedUsers.js. */
export function loadCredentials() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(
      `${CSV_PATH} not found — run "node scripts/seedUsers.js" first (this test suite logs in as real seeded accounts, not fixtures).`
    );
  }
  const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n').slice(1);
  return lines.map((line) => {
    const [role, loginId, password, teamCode] = line.split(',');
    return { role, loginId, password, teamCode: teamCode || null };
  });
}

export function pick(creds, role) {
  const row = creds.find((c) => c.role === role);
  if (!row) throw new Error(`No ${role} credential found in credentials.local.csv`);
  return row;
}
