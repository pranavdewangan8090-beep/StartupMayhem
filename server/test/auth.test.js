import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Session, loadCredentials, pick } from './helpers.js';

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

  test('fn_auth_user returns nothing for an unauthenticated caller (anon key only)', async () => {
    const s = new Session(); // never logged in — rpc() falls back to the anon key
    const rows = await s.rpc('fn_auth_user');
    assert.deepEqual(rows, []);
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
});
