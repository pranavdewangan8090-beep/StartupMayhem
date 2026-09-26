import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestTeam, cleanupTeam } from './helpers.js';
import { getSuperAdmin, getAdmin, SKIP_NO_SUPER_ADMIN } from './fixtures.js';

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

test('GET /admin/teams lists active teams with resources and identity card titles', { skip }, async () => {
  const { status, body } = await superAdmin.get('/admin/teams');
  assert.equal(status, 200);
  const row = body.find((t) => t.id === team.teamId);
  assert.ok(row);
  assert.ok(row.market_title);
  assert.equal(row.replacements_used, 0);
});

test('GET /admin/teams/:teamId/cards lists that team’s action cards', { skip }, async () => {
  const { status, body } = await superAdmin.get(`/admin/teams/${team.teamId}/cards`);
  assert.equal(status, 200);
  assert.deepEqual(body, []); // fresh team holds none yet
});

test('POST /admin/resources/adjust applies a delta and clamps at the floor', { skip }, async () => {
  const before1 = await superAdmin.get('/admin/teams');
  const rowBefore = before1.body.find((t) => t.id === team.teamId);

  const { status, body } = await superAdmin.post('/admin/resources/adjust', {
    teamId: team.teamId, dCashL: 5, dCustomers: 0, dReputation: 0, dInnovation: 0,
  });
  assert.equal(status, 200);
  assert.equal(body.after.cash_l, rowBefore.cash_l + 5);

  // driving cash to the schema's own floor (-1000) should still clamp at 0, never go negative
  const clamp = await superAdmin.post('/admin/resources/adjust', {
    teamId: team.teamId, dCashL: -1000, dCustomers: 0, dReputation: 0, dInnovation: 0,
  });
  assert.equal(clamp.status, 200);
  assert.equal(clamp.body.after.cash_l, 0);
});

test('POST /admin/decision-points/adjust accumulates a running total', { skip }, async () => {
  const first = await superAdmin.post('/admin/decision-points/adjust', { teamId: team.teamId, delta: 7 });
  assert.equal(first.status, 200);
  assert.equal(first.body.decision_points, 7);

  const second = await superAdmin.post('/admin/decision-points/adjust', { teamId: team.teamId, delta: -2 });
  assert.equal(second.status, 200);
  assert.equal(second.body.decision_points, 5);
});

test('decision-points delta of 0 is rejected', { skip }, async () => {
  const { status, body } = await superAdmin.post('/admin/decision-points/adjust', { teamId: team.teamId, delta: 0 });
  assert.equal(status, 400);
  assert.equal(body.error, 'INVALID_INPUT');
});

const adminReady = Boolean(process.env.TEST_ADMIN_ID && process.env.TEST_ADMIN_PASSWORD);
test('a real Admin account can also use the shared admin routes', { skip: !adminReady && 'set TEST_ADMIN_ID and TEST_ADMIN_PASSWORD to run' }, async () => {
  const admin = await getAdmin();
  const { status } = await admin.get('/admin/teams');
  assert.equal(status, 200);
});
