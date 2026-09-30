import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Session, loadCredentials, pick } from './helpers.js';
import { query, deleteTestTeam, closePool } from './db.js';

const creds = loadCredentials();

describe('auth (fn_login / fn_auth_user)', () => {
  test('logs in a real super admin and resolves identity', async () => {
    const sa = pick(creds, 'super_admin');
    const s = new Session();
    const result = await s.login('super_admin', sa.loginId, sa.password);
    assert.equal(result.role, 'super_admin');
    assert.equal(result.teamId, null);
    assert.ok(result.token);

    const rows = await s.rpc('fn_auth_user');
    assert.equal(rows[0].app_role, 'super_admin');
  });

  test('logs in a real player and resolves their team id', async () => {
    const player = pick(creds, 'player');
    const s = new Session();
    const result = await s.login('player', player.loginId, player.password);
    assert.equal(result.role, 'player');
    assert.ok(result.teamId);

    const rows = await s.rpc('fn_auth_user');
    assert.equal(rows[0].team_id, result.teamId);
    assert.equal(rows[0].app_role, 'player');
  });

  test('rejects a wrong password without leaking which part was wrong', async () => {
    const player = pick(creds, 'player');
    const s = new Session();
    await assert.rejects(
      () => s.login('player', player.loginId, 'definitely-wrong'),
      (err) => err.message === 'INVALID_CREDENTIALS'
    );
  });

  test('rejects a login_id that does not exist for the role', async () => {
    const s = new Session();
    await assert.rejects(
      () => s.login('player', 'NO-SUCH-TEAM', 'whatever'),
      (err) => err.message === 'INVALID_CREDENTIALS'
    );
  });

  // Before 025_security_lockdown.sql, `revoke execute ... from anon` was a
  // no-op (Postgres grants new functions to PUBLIC by default, which anon
  // inherits), so anon could enter fn_auth_user()'s body and get an empty
  // result back. Now Postgres refuses the call before the function runs —
  // the stricter behavior the original grant always intended. The real
  // client never calls fn_auth_user() without a stored token (see
  // AuthContext.refresh()), so this doesn't change app behavior.
  test('fn_auth_user is not callable by an unauthenticated caller (anon key only)', async () => {
    const s = new Session(); // never logged in — rpc() falls back to the anon key
    await assert.rejects(
      () => s.rpc('fn_auth_user'),
      (err) => err.status === 401 && /permission denied/i.test(err.message)
    );
  });

  // 030_allow_multi_session_login.sql: fn_login no longer bumps
  // session_version, specifically so a second (or third...) screen logging
  // in with the same credentials doesn't kick out an earlier one.
  test('logging in again does NOT invalidate an earlier session — many screens can share one login', async () => {
    const player = pick(creds, 'player');
    const first = new Session();
    await first.login('player', player.loginId, player.password);

    const second = new Session();
    await second.login('player', player.loginId, player.password);

    const third = new Session();
    await third.login('player', player.loginId, player.password);

    const [firstMe, secondMe, thirdMe] = await Promise.all([
      first.rpc('fn_auth_user'),
      second.rpc('fn_auth_user'),
      third.rpc('fn_auth_user'),
    ]);
    assert.ok(firstMe[0], 'the first session should still resolve an identity');
    assert.ok(secondMe[0]);
    assert.ok(thirdMe[0]);
    assert.equal(firstMe[0].team_id, secondMe[0].team_id);
    assert.equal(firstMe[0].team_id, thirdMe[0].team_id);
  });

  test('resetting a password still invalidates every existing session for that account', async () => {
    const superAdmin = new Session();
    const sa = pick(creds, 'super_admin');
    await superAdmin.login('super_admin', sa.loginId, sa.password);
    const team = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-RESETKICK-${Date.now()}` });
    try {
      const oldSession = new Session();
      await oldSession.login('player', team.loginId, team.password);
      assert.ok((await oldSession.rpc('fn_auth_user'))[0]);

      const [{ user_id: userId }] = await oldSession.rpc('fn_auth_user');
      await superAdmin.rpc('fn_super_reset_password', { p_user_id: userId });

      const rows = await oldSession.rpc('fn_auth_user');
      assert.deepEqual(rows, [], 'the pre-reset session should no longer resolve an identity');
    } finally {
      await deleteTestTeam(team.teamId);
    }
  });

  describe('login rate limiting (fn_login / login_attempts)', () => {
    let superAdmin, team;

    before(async () => {
      superAdmin = new Session();
      const sa = pick(creds, 'super_admin');
      await superAdmin.login('super_admin', sa.loginId, sa.password);
      team = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-RATELIMIT-${Date.now()}` });
    });

    after(async () => {
      await query('delete from login_attempts where login_id = $1', [team.loginId]);
      await deleteTestTeam(team.teamId);
      await closePool();
    });

    test('8 wrong passwords lock the account out, even with the right password', async () => {
      for (let i = 0; i < 8; i++) {
        await assert.rejects(() => new Session().login('player', team.loginId, 'wrong'), (err) => err.message === 'INVALID_CREDENTIALS');
      }
      await assert.rejects(
        () => new Session().login('player', team.loginId, team.password),
        (err) => err.message === 'RATE_LIMITED'
      );
    });

    test('a successful login clears the failure history', async () => {
      await query('delete from login_attempts where login_id = $1', [team.loginId]);
      for (let i = 0; i < 5; i++) {
        await assert.rejects(() => new Session().login('player', team.loginId, 'wrong'));
      }
      const s = new Session();
      await s.login('player', team.loginId, team.password); // under the threshold, so this still succeeds
      const { rows } = await query('select count(*) from login_attempts where login_id = $1', [team.loginId]);
      assert.equal(Number(rows[0].count), 0);
    });
  });
});
