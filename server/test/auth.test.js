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

  test('re-login bumps session_version and invalidates the old token', async () => {
    const player = pick(creds, 'player');
    const first = new Session();
    await first.login('player', player.loginId, player.password);

    const second = new Session();
    await second.login('player', player.loginId, player.password);

    const rows = await first.rpc('fn_auth_user');
    assert.deepEqual(rows, [], 'old token should no longer resolve an identity');

    // leave the account logged in as `second` was the last real login; log
    // back in once more so this test doesn't itself invalidate a sibling
    // test file's already-cached session for the same account.
    await first.login('player', player.loginId, player.password);
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
