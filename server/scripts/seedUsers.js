// Resets and re-creates the real accounts for the event: wipes every team,
// user, and any game data hanging off a team (action cards, trades, crisis
// effects), resets the crisis sequence and game toggles, then creates 45
// teams (with a random deal of the 5 identity cards each), 20 admins, 10
// super admins.
//
// Login IDs and passwords are STABLE across resets: this reads
// credentials.local.csv if it already exists and reuses the exact same
// login_id + password for every team/admin/super_admin slot that file
// already has one for (rehashing the same plaintext password fresh each
// time — bcrypt hashes don't need to match byte-for-byte, only verify
// against the same password). Fresh random credentials are only generated
// for slots the file doesn't have yet — e.g. raising TEAM_COUNT adds new
// teams with new credentials, without touching any existing team's login.
// This means resetting the game (wiping scores/state) never invalidates
// credentials you've already handed out.
//
// Because of that, DO NOT delete or move credentials.local.csv after
// handing out credentials the way earlier versions of this comment said to
// — it is now the durable source of truth every future reset reads back
// from. Keep it (it's already git-ignored, so it never reaches source
// control) and back it up somewhere safe instead. If you genuinely want a
// fresh, unrelated set of credentials for everyone, delete the file first;
// running with it deleted regenerates every login from scratch.
//
// Credential design: the team's display code (T01..T45, used everywhere in
// the UI/leaderboard) stays simple and sequential, but the LOGIN ID is a
// separate value with a short random suffix (T07-K3F9) — guessing a team's
// public T-number no longer gets you their login. Admin/super_admin login
// IDs drop sequential numbering entirely (AD-xxxx / SA-xxxx) since there's
// no legitimate reason for those to be guessable in order. Passwords are a
// simple 6-digit PIN — safe given fn_login's per-account rate limit (8
// failed attempts locks the account for 5 minutes, see
// server/sql/015_login_rate_limit.sql), and much faster to type on a phone
// under event conditions than a mixed-case password.
//
// Usage: node scripts/seedUsers.js
import 'dotenv/config';
import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const TEAM_COUNT = 45;
const ADMIN_COUNT = 20;
const SUPER_ADMIN_COUNT = 10;

const CSV_PATH = new URL('./credentials.local.csv', import.meta.url);

// Unambiguous alphabet (no 0/O, 1/I/l) — easy to hand-write and read aloud.
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomSuffix(len) {
  return Array.from(crypto.randomFillSync(new Uint8Array(len)))
    .map((b) => ID_ALPHABET[b % ID_ALPHABET.length])
    .join('');
}

function randomPin() {
  // 6-digit numeric PIN, no leading-zero restriction — just a string of digits.
  return Array.from(crypto.randomFillSync(new Uint8Array(6)))
    .map((b) => String(b % 10))
    .join('');
}

/** A random suffix that hasn't been used yet for this prefix, tracked in `used`. */
function uniqueLoginId(prefix, used) {
  let id;
  do {
    id = `${prefix}${randomSuffix(4)}`;
  } while (used.has(id));
  used.add(id);
  return id;
}

/**
 * Reads a previous run's credentials.local.csv, if any. Returns
 * { players: Map<teamCode, {loginId, password}>, admins: [{loginId,password}], superAdmins: [...] }
 * so this run can reuse them instead of generating new ones.
 */
function loadExistingCredentials() {
  const players = new Map();
  const admins = [];
  const superAdmins = [];
  if (!fs.existsSync(CSV_PATH)) return { players, admins, superAdmins };

  const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n').slice(1);
  for (const line of lines) {
    const [role, loginId, password, teamCode] = line.split(',');
    if (!loginId || !password) continue;
    if (role === 'player' && teamCode) players.set(teamCode, { loginId, password });
    else if (role === 'admin') admins.push({ loginId, password });
    else if (role === 'super_admin') superAdmins.push({ loginId, password });
  }
  return { players, admins, superAdmins };
}

async function pickRandomCardId(client, category, exclude = []) {
  const { rows } = await client.query(
    `select id from identity_cards where category = $1 and id <> all($2::int[]) and is_active order by random() limit 1`,
    [category, exclude]
  );
  return rows[0].id;
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const csvRows = ['role,login_id,password,team_code'];
  const usedLoginIds = new Set();
  const existing = loadExistingCredentials();
  let reusedCount = 0;
  let freshCount = 0;

  // Reserve every reused login ID up front so a freshly-generated one for a
  // NEW slot (e.g. a team added by raising TEAM_COUNT) can never collide
  // with one already in use.
  for (const { loginId } of existing.players.values()) usedLoginIds.add(loginId);
  for (const { loginId } of existing.admins) usedLoginIds.add(loginId);
  for (const { loginId } of existing.superAdmins) usedLoginIds.add(loginId);

  try {
    await client.query('BEGIN');

    // Full reset: wiping teams cascades to their users, action cards, card
    // plays, trades, and crisis effects; a separate delete clears the
    // team-less admin/super_admin users. login_attempts is cleared too, so
    // no stale lockout carries into the event.
    await client.query('delete from teams');
    await client.query('delete from users');
    await client.query('delete from login_attempts');

    // Reset shared game state too — otherwise a crisis triggered during a
    // rehearsal stays triggered and the real event starts at crisis 2 (or
    // "no more crises"). Card play starts CLOSED so nobody plays a card
    // before the GMs open that round; R1 replacements start open.
    await client.query('update crises set is_triggered = false, triggered_at = null, triggered_by = null');
    await client.query('update game_state set r1_replace_open = true, card_play_open = false, updated_at = now() where id = 1');

    for (let i = 1; i <= TEAM_COUNT; i++) {
      const teamCode = `T${String(i).padStart(2, '0')}`;
      const reused = existing.players.get(teamCode);
      let loginId, password;
      if (reused) {
        ({ loginId, password } = reused);
        reusedCount++;
      } else {
        loginId = uniqueLoginId(`${teamCode}-`, usedLoginIds);
        password = randomPin();
        freshCount++;
      }

      const marketId = await pickRandomCardId(client, 'market');
      const customerId = await pickRandomCardId(client, 'customer');
      const missionId = await pickRandomCardId(client, 'mission');
      const resourcesId = await pickRandomCardId(client, 'resources');

      const { rows: resRow } = await client.query(
        'select start_cash_l, start_customers, start_reputation, start_innovation from identity_cards where id = $1',
        [resourcesId]
      );
      const r = resRow[0];

      const { rows: teamRows } = await client.query(
        `insert into teams (team_code, cash_l, customers, reputation, innovation,
           market_card_id, customer_card_id, mission_card_id, resources_card_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [teamCode, r.start_cash_l, r.start_customers, r.start_reputation, r.start_innovation,
         marketId, customerId, missionId, resourcesId]
      );
      const teamId = teamRows[0].id;

      const hash = await bcrypt.hash(password, 10);
      await client.query(
        `insert into users (role, login_id, password_hash, team_id) values ('player', $1, $2, $3)`,
        [loginId, hash, teamId]
      );
      await client.query('select fn_issue_starting_hand($1)', [teamId]);
      csvRows.push(`player,${loginId},${password},${teamCode}`);
    }

    for (let i = 1; i <= ADMIN_COUNT; i++) {
      const reused = existing.admins[i - 1];
      let loginId, password;
      if (reused) {
        ({ loginId, password } = reused);
        reusedCount++;
      } else {
        loginId = uniqueLoginId('AD-', usedLoginIds);
        password = randomPin();
        freshCount++;
      }
      const hash = await bcrypt.hash(password, 10);
      await client.query(`insert into users (role, login_id, password_hash) values ('admin', $1, $2)`, [loginId, hash]);
      csvRows.push(`admin,${loginId},${password},`);
    }

    for (let i = 1; i <= SUPER_ADMIN_COUNT; i++) {
      const reused = existing.superAdmins[i - 1];
      let loginId, password;
      if (reused) {
        ({ loginId, password } = reused);
        reusedCount++;
      } else {
        loginId = uniqueLoginId('SA-', usedLoginIds);
        password = randomPin();
        freshCount++;
      }
      const hash = await bcrypt.hash(password, 10);
      await client.query(`insert into users (role, login_id, password_hash) values ('super_admin', $1, $2)`, [loginId, hash]);
      csvRows.push(`super_admin,${loginId},${password},`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  fs.writeFileSync(CSV_PATH, csvRows.join('\n') + '\n');
  console.log(`Reset complete: ${TEAM_COUNT} teams, ${ADMIN_COUNT} admins, ${SUPER_ADMIN_COUNT} super admins.`);
  console.log('Game state reset: all crises untriggered, R1 replacements OPEN, card play CLOSED, trading OFF.');
  console.log(`Credentials: ${reusedCount} reused unchanged, ${freshCount} newly generated.`);
  console.log(`Written to ${CSV_PATH.pathname} — keep this file (do not delete it): it's how future resets keep credentials stable. It is git-ignored and must never be committed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
