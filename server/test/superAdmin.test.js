import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Session, loadCredentials, pick } from './helpers.js';
import { deleteTestTeam, closePool } from './db.js';

const creds = loadCredentials();
let superAdmin, admin;

before(async () => {
  superAdmin = new Session();
  const sa = pick(creds, 'super_admin');
  await superAdmin.login('super_admin', sa.loginId, sa.password);

  const adminCred = pick(creds, 'admin');
  admin = new Session();
  await admin.login('admin', adminCred.loginId, adminCred.password);
});

after(async () => {
  await closePool();
});

describe('super admin only', () => {
  test('an admin (not super_admin) cannot flip toggles', async () => {
    await assert.rejects(
      () => admin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: true }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });

  test('toggle set + get round-trips, and only accepts known keys', async () => {
    const before = await superAdmin.rpc('fn_super_toggles_get');
    const flipped = !before.card_play_open;
    await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: flipped });
    const after = await superAdmin.rpc('fn_super_toggles_get');
    assert.equal(after.card_play_open, flipped);
    await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: before.card_play_open }); // restore

    await assert.rejects(
      () => superAdmin.rpc('fn_super_toggles_set', { p_key: 'not_a_real_toggle', p_value: true }),
      (err) => err.message === 'BAD_TOGGLE_KEY'
    );
  });

  test('add team, adjust it, mark its mission, then deactivate', async () => {
    const created = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-SA-${Date.now()}` });
    assert.ok(created.teamId);
    assert.ok(created.password);

    const resResult = await superAdmin.rpc('fn_admin_adjust_resources', {
      p_team_id: created.teamId,
      p_delta: { cash_l: 5, reputation: 100 }, // reputation intentionally overflows the 0-5 cap
    });
    assert.equal(resResult.after.cash_l, resResult.before.cash_l + 5);
    assert.equal(resResult.after.reputation, 5, 'reputation should clamp at 5');

    const pointsResult = await superAdmin.rpc('fn_admin_adjust_decision_points', { p_team_id: created.teamId, p_payload: { delta: 7 } });
    assert.equal(pointsResult.decision_points, 7);

    await superAdmin.rpc('fn_super_mark_mission', { p_team_id: created.teamId, p_completed: true });
    const leaderboard = await superAdmin.rpc('fn_super_leaderboard_raw');
    const row = leaderboard.find((r) => r.team_id === created.teamId);
    assert.equal(row.mission_completed, true);

    const points = await superAdmin.rpc('fn_super_decision_points');
    assert.ok(points.some((p) => p.team_id === created.teamId));

    await superAdmin.rpc('fn_super_deactivate_team', { p_team_id: created.teamId });
    const teamsAfterDeactivate = await superAdmin.rpc('fn_admin_teams');
    assert.ok(!teamsAfterDeactivate.some((t) => t.id === created.teamId), 'deactivated team should drop out of the active list');

    // fn_super_deactivate_team only flips is_active — actually remove the row
    await deleteTestTeam(created.teamId);
  });

  test('fn_super_reset_password issues a new working password', async () => {
    const created = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-SA-RESET-${Date.now()}` });
    const oldPlayer = new Session();
    await oldPlayer.login('player', created.loginId, created.password);

    // fetch the user id via a direct read since no RPC exposes it — reuse fn_auth_user() on the session we already have
    const [{ user_id: userId }] = await oldPlayer.rpc('fn_auth_user');
    const reset = await superAdmin.rpc('fn_super_reset_password', { p_user_id: userId });
    assert.equal(reset.loginId, created.loginId);

    const newPlayer = new Session();
    await newPlayer.login('player', created.loginId, reset.password);
    assert.ok(newPlayer.token);

    await assert.rejects(
      () => new Session().login('player', created.loginId, created.password),
      (err) => err.message === 'INVALID_CREDENTIALS'
    );

    await deleteTestTeam(created.teamId);
  });
});
