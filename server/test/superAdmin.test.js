import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestTeam, cleanupTeam } from './helpers.js';
import { getSuperAdmin, SKIP_NO_SUPER_ADMIN } from './fixtures.js';

const canRun = Boolean(process.env.TEST_SUPER_ADMIN_ID && process.env.TEST_SUPER_ADMIN_PASSWORD);
const skip = !canRun && SKIP_NO_SUPER_ADMIN;

let superAdmin, team;

before(async () => {
  superAdmin = await getSuperAdmin();
  if (!superAdmin) return;
  team = await createTestTeam(superAdmin);
});

after(async () => {
  if (superAdmin && team) await cleanupTeam(superAdmin, team.teamId);
});

test('GET /super-admin/toggles round-trips a flip back to its original value', { skip }, async () => {
  const before1 = await superAdmin.get('/super-admin/toggles');
  const original = before1.body.card_play_open;

  const flip = await superAdmin.post('/super-admin/toggles', { key: 'card_play_open', value: !original });
  assert.equal(flip.status, 200);
  const after1 = await superAdmin.get('/super-admin/toggles');
  assert.equal(after1.body.card_play_open, !original);

  // restore
  await superAdmin.post('/super-admin/toggles', { key: 'card_play_open', value: original });
  const restored = await superAdmin.get('/super-admin/toggles');
  assert.equal(restored.body.card_play_open, original);
});

test('an unknown toggle key is rejected', { skip }, async () => {
  const { status, body } = await superAdmin.post('/super-admin/toggles', { key: 'not_a_real_toggle', value: true });
  assert.equal(status, 400);
  assert.equal(body.error, 'INVALID_INPUT');
});

test('POST /super-admin/teams creates a real, log-in-able team (exercised by createTestTeam in every other suite)', { skip }, async () => {
  const { status, body } = await superAdmin.post('/super-admin/teams', { teamCode: `ZTMP${Math.floor(Math.random() * 100000)}` });
  assert.equal(status, 200);
  assert.ok(body.teamId && body.password);
  await cleanupTeam(superAdmin, body.teamId);
});

test('deactivating a team removes it from the active team list', { skip }, async () => {
  const disposable = await createTestTeam(superAdmin);
  await cleanupTeam(superAdmin, disposable.teamId);
  const { body } = await superAdmin.get('/admin/teams');
  assert.ok(!body.some((t) => t.id === disposable.teamId));
});

test('reset-password on an unknown user id returns 404', { skip }, async () => {
  const { status, body } = await superAdmin.post('/super-admin/users/00000000-0000-0000-0000-000000000000/reset-password', {});
  assert.equal(status, 404);
  assert.equal(body.error, 'USER_NOT_FOUND');
});

test('GET /super-admin/decision-points lists every team’s running total', { skip }, async () => {
  const { status, body } = await superAdmin.get('/super-admin/decision-points');
  assert.equal(status, 200);
  assert.ok(body.some((t) => t.team_id === team.teamId));
});

test('GET /super-admin/leaderboard scores every active team', { skip }, async () => {
  const { status, body } = await superAdmin.get('/super-admin/leaderboard');
  assert.equal(status, 200);
  const row = body.find((t) => t.teamId === team.teamId);
  assert.ok(row);
  for (const key of ['resourceScore', 'decisionScore', 'missionBonus', 'totalScore']) {
    assert.ok(typeof row[key] === 'number');
  }
});

test('POST /super-admin/mission/mark toggles a team’s secret-mission flag', { skip }, async () => {
  const mark = await superAdmin.post('/super-admin/mission/mark', { teamId: team.teamId, completed: true });
  assert.equal(mark.status, 200);
  const status = await team.playerSession.get('/player/status');
  assert.equal(status.body.mission_completed, true);

  await superAdmin.post('/super-admin/mission/mark', { teamId: team.teamId, completed: false });
});

test('only a super_admin (not a plain admin) can reach super-admin-only mutations like /teams', { skip: !process.env.TEST_ADMIN_ID && 'set TEST_ADMIN_ID/TEST_ADMIN_PASSWORD to run' }, async () => {
  const { getAdmin } = await import('./fixtures.js');
  const admin = await getAdmin();
  const { status } = await admin.post('/super-admin/teams', { teamCode: 'SHOULD-FAIL' });
  assert.equal(status, 403);
});
