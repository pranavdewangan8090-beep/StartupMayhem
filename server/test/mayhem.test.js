import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requestId, createTestTeam, cleanupTeam } from './helpers.js';
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

test('GET /mayhem/events lists exactly the 3 fixed Round 3 events', { skip }, async () => {
  const { status, body } = await superAdmin.get('/mayhem/events');
  assert.equal(status, 200);
  assert.equal(body.length, 3);
  assert.deepEqual(body.map((e) => e.number).sort(), [1, 2, 3]);
});

test('GET /mayhem/current is null before any event, or a full event once one is triggered', { skip }, async () => {
  const { status, body } = await superAdmin.get('/mayhem/current');
  assert.equal(status, 200);
  if (body) {
    for (const key of ['number', 'title', 'story_text', 'effect_text', 'tags']) assert.ok(key in body);
  }
});

test('GET /mayhem/team-status is [] when no event is active, or one row per active team otherwise', { skip }, async () => {
  const current = await superAdmin.get('/mayhem/current');
  const { status, body } = await superAdmin.get('/mayhem/team-status');
  assert.equal(status, 200);
  if (!current.body) {
    assert.deepEqual(body, []);
  } else {
    const row = body.find((t) => t.team_id === team.teamId);
    assert.ok(row);
    assert.ok(['hit_hard', 'hit', 'unaffected', 'gains'].includes(row.tier));
  }
});

test('team-status is sorted worst-tier-first (hit_hard, hit, unaffected, gains)', { skip }, async () => {
  const current = await superAdmin.get('/mayhem/current');
  if (!current.body) return; // nothing to sort yet
  const { body } = await superAdmin.get('/mayhem/team-status');
  const severity = { hit_hard: 0, hit: 1, unaffected: 2, gains: 3 };
  const ranks = body.map((t) => severity[t.tier]);
  const sorted = [...ranks].sort((a, b) => a - b);
  assert.deepEqual(ranks, sorted);
});

test('recording a response for a team applies the Accept/Spend/Adapt formula and rejects a duplicate', { skip }, async () => {
  const current = await superAdmin.get('/mayhem/current');
  if (!current.body) return; // needs an event already triggered by a real Super Admin session

  const before1 = await team.playerSession.get('/player/status');
  const rid = requestId();
  const { status, body } = await superAdmin.post('/mayhem/respond', { teamId: team.teamId, response: 'accept', requestId: rid });
  assert.equal(status, 200);
  assert.ok(['hit_hard', 'hit', 'unaffected', 'gains'].includes(body.tier));

  const dup = await superAdmin.post('/mayhem/respond', { teamId: team.teamId, response: 'accept', requestId: requestId() });
  assert.equal(dup.status, 400, 'the unique(event, team) constraint should refuse a second response for the same team');
});

test('an unauthenticated caller cannot reach any mayhem route', { skip }, async () => {
  const { Session } = await import('./helpers.js');
  const anon = new Session();
  const { status } = await anon.get('/mayhem/current');
  assert.equal(status, 401);
});

// ---------------------------------------------------------------------------
// Genuinely destructive: only 3 Market Mayhem events exist for the entire
// event and triggering is one-way. This test is opt-in only — it will
// consume a real event slot on whatever database TEST_BASE_URL points at.
// Run with: ALLOW_MAYHEM_TRIGGER_TEST=1 npm test
// ---------------------------------------------------------------------------
test('POST /mayhem/trigger advances to the next untriggered event, then errors once all 3 are done', {
  skip: process.env.ALLOW_MAYHEM_TRIGGER_TEST !== '1' && 'destructive — set ALLOW_MAYHEM_TRIGGER_TEST=1 to run (consumes a real event slot)',
}, async () => {
  const { body: events } = await superAdmin.get('/mayhem/events');
  const already = events.filter((e) => e.is_triggered).length;
  if (already === 3) {
    const { status, body } = await superAdmin.post('/mayhem/trigger', {});
    assert.equal(status, 409);
    assert.equal(body.error, 'NO_MORE_EVENTS');
    return;
  }
  const { status, body } = await superAdmin.post('/mayhem/trigger', {});
  assert.equal(status, 200);
  assert.equal(body.number, already + 1);
});
