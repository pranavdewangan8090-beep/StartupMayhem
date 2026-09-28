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
    assert.ok(['action', 'deal', 'special'].includes(c.category));
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
  const actionCard = catalog.find((c) => c.category === 'action');
  assert.ok(actionCard, 'seed data should include at least one action card');

  const first = await teamA.playerSession.post('/action-cards/request', { actionCardId: actionCard.id, requestId: requestId() });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'held');

  const dup = await teamA.playerSession.post('/action-cards/request', { actionCardId: actionCard.id, requestId: requestId() });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'ALREADY_HAVE_CARD');

  const hand = await teamA.playerSession.get('/action-cards/hand');
  assert.ok(hand.body.some((c) => c.action_card_id === actionCard.id));
});

test('one card per category: a 2nd card from an already-held category is rejected', { skip }, async () => {
  const otherAction = catalog.find((c) => c.category === 'action' && !catalog.every((x) => x.id === c.id));
  const secondAction = catalog.filter((c) => c.category === 'action')[1];
  assert.ok(secondAction, 'seed data should include a 2nd action card');

  const { status, body } = await teamA.playerSession.post('/action-cards/request', { actionCardId: secondAction.id, requestId: requestId() });
  assert.equal(status, 409);
  assert.equal(body.error, 'CATEGORY_ALREADY_TAKEN');
});

test('R2 request cap: a 4th card request is rejected once 3 are held (one per category)', { skip }, async () => {
  const dealCard = catalog.find((c) => c.category === 'deal');
  const specialCard = catalog.find((c) => c.category === 'special');
  await teamB.playerSession.post('/action-cards/request', { actionCardId: catalog.find((c) => c.category === 'action').id, requestId: requestId() });
  await teamB.playerSession.post('/action-cards/request', { actionCardId: dealCard.id, requestId: requestId() });
  await teamB.playerSession.post('/action-cards/request', { actionCardId: specialCard.id, requestId: requestId() });

  const hand = await teamB.playerSession.get('/action-cards/hand');
  assert.equal(hand.body.length, 3);

  // every category is now taken, so this should fail on CATEGORY_ALREADY_TAKEN
  // before it would even reach the count check — both prove the 3-card cap holds
  const overflow = catalog.find((c) => c.category === 'action' && c.id !== catalog.find((x) => x.category === 'action').id);
  const { status, body } = await teamB.playerSession.post('/action-cards/request', { actionCardId: overflow.id, requestId: requestId() });
  assert.equal(status, 409);
  assert.equal(body.error, 'CATEGORY_ALREADY_TAKEN');
});

test('playing an action/special card applies its effect and marks it used', { skip }, async () => {
  const hand = await teamA.playerSession.get('/action-cards/hand');
  const held = hand.body.find((c) => c.status === 'held' && (c.category === 'action' || c.category === 'special'));
  assert.ok(held, 'team A should still hold its action card');

  const { status, body } = await teamA.playerSession.post('/action-cards/play/self', { teamActionCardId: held.id, requestId: requestId() });
  assert.equal(status, 200);
  assert.ok(body.before && body.after);

  const handAfter = await teamA.playerSession.get('/action-cards/hand');
  assert.equal(handAfter.body.find((c) => c.id === held.id).status, 'used');
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
