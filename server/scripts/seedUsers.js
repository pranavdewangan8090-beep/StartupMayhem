// Resets and re-creates the real accounts for the event: wipes every team,
// user, and any game data hanging off a team (action cards, trades, crisis
// effects), resets the crisis sequence and game toggles, then creates 30 teams (with a random deal of the 5 identity
// cards each), 20 admins, 10 super admins. Passwords and login IDs are
// randomly generated and written to a local CSV — this file is NEVER
// committed (it's covered by .gitignore) and should be deleted/moved
// somewhere safe once you've handed out credentials.
//
// Credential design: the team's display code (T01..T30, used everywhere in
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

const TEAM_COUNT = 30;
const ADMIN_COUNT = 20;
const SUPER_ADMIN_COUNT = 10;

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

async function pickRandomCardId(client, category, exclude = []) {
  const { rows } = await client.query(
    `select id from identity_cards where category = $1 and id <> all($2::int[]) order by random() limit 1`,
    [category, exclude]
  );
  return rows[0].id;
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const csvRows = ['role,login_id,password,team_code'];
  const usedLoginIds = new Set();

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
      const loginId = uniqueLoginId(`${teamCode}-`, usedLoginIds);
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

      const password = randomPin();
      const hash = await bcrypt.hash(password, 10);
      await client.query(
        `insert into users (role, login_id, password_hash, team_id) values ('player', $1, $2, $3)`,
        [loginId, hash, teamId]
      );
      await client.query('select fn_issue_starting_hand($1)', [teamId]);
      csvRows.push(`player,${loginId},${password},${teamCode}`);
    }

    for (let i = 1; i <= ADMIN_COUNT; i++) {
      const loginId = uniqueLoginId('AD-', usedLoginIds);
      const password = randomPin();
      const hash = await bcrypt.hash(password, 10);
      await client.query(`insert into users (role, login_id, password_hash) values ('admin', $1, $2)`, [loginId, hash]);
      csvRows.push(`admin,${loginId},${password},`);
    }

    for (let i = 1; i <= SUPER_ADMIN_COUNT; i++) {
      const loginId = uniqueLoginId('SA-', usedLoginIds);
      const password = randomPin();
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

  const outPath = new URL('./credentials.local.csv', import.meta.url);
  fs.writeFileSync(outPath, csvRows.join('\n') + '\n');
  console.log(`Reset complete: ${TEAM_COUNT} teams, ${ADMIN_COUNT} admins, ${SUPER_ADMIN_COUNT} super admins.`);
  console.log('Game state reset: all crises untriggered, R1 replacements OPEN, card play CLOSED, trading OFF.');
  console.log(`Credentials written to ${outPath.pathname} — keep this file safe and do not commit it.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
