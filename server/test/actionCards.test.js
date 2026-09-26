import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requestId, createTestTeam, cleanupTeam } from './helpers.js';
import { getSuperAdmin, SKIP_NO_SUPER_ADMIN } from './fixtures.js';

const canRun = Boolean(process.env.TEST_SUPER_ADMIN_ID && process.env.TEST_SUPER_ADMIN_PASSWORD);
const skip = !canRun && SKIP_NO_SUPER_ADMIN;

let superAdmin, teamA, teamB, originalToggles;
let catalog = [];

before(async () => {
  superAdmin = await getSuperAdmin();
  if (!superAdmin) return;
  teamA = await createTestTeam(superAdmin);
  teamB = await createTestTeam(superAdmin);

  const { body } = await superAdmin.get('/super-admin/toggles');
  originalToggles = { r2_selection_open: body.r2_selection_open, card_play_open: body.card_play_open };
  if (!body.r2_selection_open) await superAdmin.post('/super-admin/toggles', { key: 'r2_selection_open', value: true });
  if (!body.card_play_open) await superAdmin.post('/super-admin/toggles', { key: 'card_play_open', value: true });

  const cat = await teamA.playerSession.get('/action-cards/catalog');
  catalog = cat.body;
});

after(async () => {
  if (!superAdmin) return;
  if (teamA) await cleanupTeam(superAdmin, teamA.teamId);
  if (teamB) await cleanupTeam(superAdmin, teamB.teamId);
  if (originalToggles?.r2_selection_open === false) await superAdmin.post('/super-admin/toggles', { key: 'r2_selection_open', value: false });
  if (originalToggles?.card_play_open === false) await superAdmin.post('/super-admin/toggles', { key: 'card_play_open', value: false });
});

test('GET /action-cards/catalog lists all active cards with category/name/effect', { skip }, async () => {
  assert.ok(catalog.length > 0);
  for (const c of catalog) {
    assert.ok(['self_help', 'attack', 'deal', 'special'].includes(c.category));
    assert.ok(c.name);
    assert.ok(c.effect_text);
  }
});

test('GET /action-cards/teams lists other active teams, excluding self', { skip }, async () => {
  const { status, body } = await teamA.playerSession.get('/action-cards/teams');
  assert.equal(status, 200);
  assert.ok(body.some((t) => t.id === teamB.teamId));
  assert.ok(!body.some((t) => t.id === teamA.teamId));
});

test('requesting an action card adds it to hand; requesting the same card twice is rejected', { skip }, async () => {
  const selfHelp = catalog.find((c) => c.category === 'self_help');
  assert.ok(selfHelp, 'seed data should include at least one self_help card');

  const first = await teamA.playerSession.post('/action-cards/request', { actionCardId: selfHelp.id, requestId: requestId() });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'held');

  const dup = await teamA.playerSession.post('/action-cards/request', { actionCardId: selfHelp.id, requestId: requestId() });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'ALREADY_HAVE_CARD');

  const hand = await teamA.playerSession.get('/action-cards/hand');
  assert.ok(hand.body.some((c) => c.action_card_id === selfHelp.id));
});

test('R2 request cap: a 5th card request is rejected once 4 are held', { skip }, async () => {
  const remaining = catalog.filter((c) => c.category !== 'self_help').slice(0, 4);
  for (const c of remaining) {
    await teamB.playerSession.post('/action-cards/request', { actionCardId: c.id, requestId: requestId() });
  }
  const hand = await teamB.playerSession.get('/action-cards/hand');
  assert.equal(hand.body.length, 4);

  const overflow = catalog.find((c) => !remaining.includes(c));
  const { status, body } = await teamB.playerSession.post('/action-cards/request', { actionCardId: overflow.id, requestId: requestId() });
  assert.equal(status, 403);
  assert.equal(body.error, 'R2_LIMIT_REACHED');
});

test('playing a self_help/special card applies its effect and marks it used', { skip }, async () => {
  const hand = await teamA.playerSession.get('/action-cards/hand');
  const held = hand.body.find((c) => c.status === 'held' && (c.category === 'self_help' || c.category === 'special'));
  assert.ok(held, 'team A should still hold its self_help card');

  const before1 = await teamA.playerSession.get('/player/status');
  const { status, body } = await teamA.playerSession.post('/action-cards/play/self', { teamActionCardId: held.id, requestId: requestId() });
  assert.equal(status, 200);
  assert.ok(body.before && body.after);

  const handAfter = await teamA.playerSession.get('/action-cards/hand');
  assert.equal(handAfter.body.find((c) => c.id === held.id).status, 'used');
});

test('playing an attack card affects both the player and the named target', { skip }, async () => {
  const attackCard = catalog.find((c) => c.category === 'attack');
  assert.ok(attackCard);
  await teamA.playerSession.post('/action-cards/request', { actionCardId: attackCard.id, requestId: requestId() });
  const hand = await teamA.playerSession.get('/action-cards/hand');
  const held = hand.body.find((c) => c.action_card_id === attackCard.id && c.status === 'held');

  const { status, body } = await teamA.playerSession.post('/action-cards/play/attack', {
    teamActionCardId: held.id, targetTeamId: teamB.teamId, requestId: requestId(),
  });
  assert.equal(status, 200);
  assert.ok(body.self_after && body.target_after);
});

test('attack cannot target your own team', { skip }, async () => {
  const hand = await teamB.playerSession.get('/action-cards/hand');
  const heldAttack = hand.body.find((c) => c.category === 'attack' && c.status === 'held');
  assert.ok(heldAttack, 'team B should hold an unused attack card from the R2-cap test');

  const { status, body } = await teamB.playerSession.post('/action-cards/play/attack', {
    teamActionCardId: heldAttack.id, targetTeamId: teamB.teamId, requestId: requestId(),
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'CANNOT_TARGET_SELF');
});

test('a deal card proposes to a partner, who can accept it', { skip }, async () => {
  const dealCard = catalog.find((c) => c.category === 'deal');
  assert.ok(dealCard, 'seed data should include at least one deal card');
  await teamA.playerSession.post('/action-cards/request', { actionCardId: dealCard.id, requestId: requestId() });
  const hand = await teamA.playerSession.get('/action-cards/hand');
  const held = hand.body.find((c) => c.action_card_id === dealCard.id && c.status === 'held');

  const propose = await teamA.playerSession.post('/action-cards/play/deal', {
    teamActionCardId: held.id, partnerTeamId: teamB.teamId, requestId: requestId(),
  });
  assert.equal(propose.status, 200);
  assert.equal(propose.body.status, 'pending');

  const incoming = await teamB.playerSession.get('/action-cards/deals/incoming');
  const offer = incoming.body.find((d) => d.id === propose.body.id);
  assert.ok(offer, 'the partner should see the incoming deal offer');

  const respond = await teamB.playerSession.post('/action-cards/deals/respond', {
    cardPlayId: propose.body.id, accept: true, requestId: requestId(),
  });
  assert.equal(respond.status, 200);
  assert.equal(respond.body.accepted, true);
});
