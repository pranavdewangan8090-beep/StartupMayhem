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

describe('admin (fn_admin_*): both admin and super_admin may act', () => {
  test('fn_admin_teams lists the disposable team', async () => {
    const teams = await admin.rpc('fn_admin_teams');
    assert.ok(teams.some((t) => t.id === team.teamId));
  });

  test('fn_admin_adjust_resources applies deltas with caps/floors', async () => {
    const result = await admin.rpc('fn_admin_adjust_resources', {
      p_team_id: team.teamId,
      p_delta: { cash_l: 5, reputation: 100 }, // reputation intentionally overflows the 0-5 cap
    });
    assert.equal(result.after.cash_l, result.before.cash_l + 5);
    assert.equal(result.after.reputation, 5, 'reputation should clamp at 5');
  });

  test('fn_admin_adjust_decision_points is hidden from players but not admin', async () => {
    const updated = await admin.rpc('fn_admin_adjust_decision_points', { p_team_id: team.teamId, p_payload: { delta: 7 } });
    assert.equal(updated.decision_points, 7);
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
