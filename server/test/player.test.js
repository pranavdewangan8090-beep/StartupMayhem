import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requestId, createTestTeam, cleanupTeam } from './helpers.js';
import { getSuperAdmin, SKIP_NO_SUPER_ADMIN } from './fixtures.js';

const canRun = Boolean(process.env.TEST_SUPER_ADMIN_ID && process.env.TEST_SUPER_ADMIN_PASSWORD);
const skip = !canRun && SKIP_NO_SUPER_ADMIN;

let superAdmin, team, originalToggle;

before(async () => {
  superAdmin = await getSuperAdmin();
  if (!superAdmin) return;
  team = await createTestTeam(superAdmin);
  // force replacements open for this suite, restoring whatever it was after
  const { body } = await superAdmin.get('/super-admin/toggles');
  originalToggle = body.r1_replace_open;
  if (!originalToggle) await superAdmin.post('/super-admin/toggles', { key: 'r1_replace_open', value: true });
});

after(async () => {
  if (!superAdmin) return;
  if (team) await cleanupTeam(superAdmin, team.teamId);
  if (originalToggle === false) await superAdmin.post('/super-admin/toggles', { key: 'r1_replace_open', value: false });
});

test('GET /player/cards returns all 5 identity card categories with full detail', { skip }, async () => {
  const { status, body } = await team.playerSession.get('/player/cards');
  assert.equal(status, 200);
  for (const cat of ['market', 'customer', 'mission', 'resources']) {
    assert.ok(body[`${cat}_id`], `missing ${cat}_id`);
    assert.ok(body[`${cat}_title`], `missing ${cat}_title`);
    assert.ok(body[`${cat}_desc`], `missing ${cat}_desc`);
  }
  assert.equal(body.replacements_used, 0);
});

test('GET /player/status returns the team’s live resources', { skip }, async () => {
  const { status, body } = await team.playerSession.get('/player/status');
  assert.equal(status, 200);
  for (const key of ['cash_l', 'customers', 'reputation', 'innovation', 'mission_completed']) {
    assert.ok(key in body, `missing ${key}`);
  }
});

test('card replacement swaps the card and decrements the counter', { skip }, async () => {
  const before1 = await team.playerSession.get('/player/cards');
  const oldMarketId = before1.body.market_id;

  const { status, body } = await team.playerSession.post('/player/cards/replace', { category: 'market', requestId: requestId() });
  assert.equal(status, 200);
  assert.notEqual(body.id, oldMarketId, 'replacement should draw a different card');
  assert.equal(body.category, 'market');

  const after1 = await team.playerSession.get('/player/cards');
  assert.equal(after1.body.replacements_used, 1);
  assert.equal(after1.body.market_id, body.id);
});

test('rejects an unknown card category', { skip }, async () => {
  const { status, body } = await team.playerSession.post('/player/cards/replace', { category: 'nonsense', requestId: requestId() });
  assert.equal(status, 400);
  assert.equal(body.error, 'INVALID_INPUT');
});

test('replacement limit: the 4th replacement of the same team is rejected', { skip }, async () => {
  // 1 replacement already used by the earlier test in this file; use up the
  // remaining 2, then confirm the 4th is refused.
  await team.playerSession.post('/player/cards/replace', { category: 'customer', requestId: requestId() });
  await team.playerSession.post('/player/cards/replace', { category: 'resources', requestId: requestId() });
  const { status, body } = await team.playerSession.post('/player/cards/replace', { category: 'mission', requestId: requestId() });
  assert.equal(status, 403);
  assert.equal(body.error, 'REPLACEMENT_LIMIT_REACHED');
});

test('GET /player/state long-poll returns 204 when nothing changed, 200 with a payload otherwise', { skip }, async () => {
  const first = await team.playerSession.get('/player/state?v=0');
  assert.equal(first.status, 200);
  assert.ok(typeof first.body.version === 'number');

  const same = await team.playerSession.get(`/player/state?v=${first.body.version}`);
  assert.equal(same.status, 204);
});

test('a player cannot access admin-only or super-admin-only routes', { skip }, async () => {
  const asAdmin = await team.playerSession.get('/admin/teams');
  assert.equal(asAdmin.status, 403);
  const asSuper = await team.playerSession.get('/super-admin/toggles');
  assert.equal(asSuper.status, 403);
  const asMayhem = await team.playerSession.get('/mayhem/current');
  assert.equal(asMayhem.status, 403);
});
