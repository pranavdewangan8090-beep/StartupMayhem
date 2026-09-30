// Direct Postgres access for test setup/verification/teardown only — never
// used to exercise game logic (that always goes through helpers.js's RPC
// calls, exactly like the real client). Used to hard-delete disposable test
// teams afterward (fn_super_deactivate_team only deactivates, it doesn't
// clean up), and to spot-check that an RPC's effect actually landed.
import 'dotenv/config';
import pg from 'pg';

// Short timeouts so a blocked network path (direct Postgres/5432 is often
// firewalled off a given machine even when the Supabase REST API is fine)
// fails a single query in a few seconds instead of hanging every test
// file's teardown for a minute-plus.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 6000 });

export async function query(sql, params) {
  return pool.query(sql, params);
}

/** Permanently removes a team created via fn_super_add_team during a test. */
export async function deleteTestTeam(teamId) {
  await pool.query('delete from users where team_id = $1', [teamId]);
  await pool.query('delete from teams where id = $1', [teamId]);
}

export async function closePool() {
  await pool.end();
}
