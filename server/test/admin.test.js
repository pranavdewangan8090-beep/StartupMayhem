import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Session, loadCredentials, pick } from './helpers.js';
import { deleteTestTeam, closePool } from './db.js';

const creds = loadCredentials();
let superAdmin, admin, team;

before(async () => {
  superAdmin = new Session();
  const sa = pick(creds, 'super_admin');
  await superAdmin.login('super_admin', sa.loginId, sa.password);

  const adminCred = pick(creds, 'admin');
  admin = new Session();
  await admin.login('admin', adminCred.loginId, adminCred.password);

  team = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-ADMIN-${Date.now()}` });
});

after(async () => {
  await deleteTestTeam(team.teamId);
  await closePool();
});

describe('admin (fn_admin_*): read paths are shared, resource/points writes are Super Admin only', () => {
  test('fn_admin_teams lists the disposable team', async () => {
    const teams = await admin.rpc('fn_admin_teams');
    assert.ok(teams.some((t) => t.id === team.teamId));
  });

  test('Round 3: an admin (not super_admin) can no longer adjust resources', async () => {
    await assert.rejects(
      () => admin.rpc('fn_admin_adjust_resources', { p_team_id: team.teamId, p_delta: { cash_l: 5 } }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });

  test('Round 3: an admin (not super_admin) can no longer adjust decision points', async () => {
    await assert.rejects(
      () => admin.rpc('fn_admin_adjust_decision_points', { p_team_id: team.teamId, p_payload: { delta: 7 } }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });

  test('a player cannot call any admin function', async () => {
    const playerCred = pick(creds, 'player');
    const player = new Session();
    await player.login('player', playerCred.loginId, playerCred.password);
    await assert.rejects(
      () => player.rpc('fn_admin_teams'),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
    await assert.rejects(
      () => player.rpc('fn_admin_adjust_resources', { p_team_id: team.teamId, p_delta: { cash_l: 1 } }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });

  test('an unauthenticated caller cannot call any admin function', async () => {
    const anon = new Session();
    await assert.rejects(
      () => anon.rpc('fn_admin_teams'),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });
});
