import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requestId, createTestTeam, cleanupTeam } from './helpers.js';
import { getSuperAdmin, SKIP_NO_SUPER_ADMIN } from './fixtures.js';

const canRun = Boolean(process.env.TEST_SUPER_ADMIN_ID && process.env.TEST_SUPER_ADMIN_PASSWORD);
const skip = !canRun && SKIP_NO_SUPER_ADMIN;

let superAdmin, seller, buyer, originalToggles;
let sellerCardId, buyerCardId, listingId;

before(async () => {
  superAdmin = await getSuperAdmin();
  if (!superAdmin) return;
  seller = await createTestTeam(superAdmin);
  buyer = await createTestTeam(superAdmin);

  const { body } = await superAdmin.get('/super-admin/toggles');
  originalToggles = { r2_selection_open: body.r2_selection_open, marketplace_open: body.marketplace_open };
  if (!body.r2_selection_open) await superAdmin.post('/super-admin/toggles', { key: 'r2_selection_open', value: true });
  if (!body.marketplace_open) await superAdmin.post('/super-admin/toggles', { key: 'marketplace_open', value: true });

  const catalog = (await seller.playerSession.get('/action-cards/catalog')).body;
  const [cardOne, cardTwo] = catalog;
  await seller.playerSession.post('/action-cards/request', { actionCardId: cardOne.id, requestId: requestId() });
  await buyer.playerSession.post('/action-cards/request', { actionCardId: cardTwo.id, requestId: requestId() });
  sellerCardId = (await seller.playerSession.get('/action-cards/hand')).body[0].id;
  buyerCardId = (await buyer.playerSession.get('/action-cards/hand')).body[0].id;
});

after(async () => {
  if (!superAdmin) return;
  if (seller) await cleanupTeam(superAdmin, seller.teamId);
  if (buyer) await cleanupTeam(superAdmin, buyer.teamId);
  if (originalToggles?.r2_selection_open === false) await superAdmin.post('/super-admin/toggles', { key: 'r2_selection_open', value: false });
  if (originalToggles?.marketplace_open === false) await superAdmin.post('/super-admin/toggles', { key: 'marketplace_open', value: false });
});

test('listing a held card puts it up for trade and it appears in the marketplace', { skip }, async () => {
  const { status, body } = await seller.playerSession.post('/market/list', { teamActionCardId: sellerCardId, requestId: requestId() });
  assert.equal(status, 200);
  listingId = body.id;

  const listings = await buyer.playerSession.get('/market/listings');
  assert.ok(listings.body.others.some((l) => l.listing_id === listingId));

  const own = await seller.playerSession.get('/market/listings');
  assert.ok(own.body.mine.some((l) => l.listing_id === listingId));
});

test('a listed card cannot be listed again (not held anymore)', { skip }, async () => {
  const { status, body } = await seller.playerSession.post('/market/list', { teamActionCardId: sellerCardId, requestId: requestId() });
  assert.equal(status, 409);
  assert.equal(body.error, 'CARD_NOT_AVAILABLE');
});

test('GET /market/my-tradable-cards only shows the caller’s own held cards', { skip }, async () => {
  const { body } = await buyer.playerSession.get('/market/my-tradable-cards');
  assert.ok(body.some((c) => c.id === buyerCardId));
});

test('offering a trade, then the seller accepting it, swaps ownership', { skip }, async () => {
  const offer = await buyer.playerSession.post('/market/offer', {
    listingId, offeredTeamActionCardId: buyerCardId, requestId: requestId(),
  });
  assert.equal(offer.status, 200);
  const offerId = offer.body.id;

  const received = await seller.playerSession.get('/market/offers/received');
  assert.ok(received.body.some((o) => o.offer_id === offerId));

  const respond = await seller.playerSession.post('/market/offers/respond', { offerId, accept: true, requestId: requestId() });
  assert.equal(respond.status, 200);
  assert.equal(respond.body.accepted, true);

  // ownership should have swapped: the buyer now holds what was the seller's card
  const buyerHand = await buyer.playerSession.get('/action-cards/hand');
  assert.ok(buyerHand.body.some((c) => c.id === sellerCardId && c.status === 'held'));
});

test('unlisting an active listing returns the card to held and voids pending offers', { skip }, async () => {
  const catalog = (await seller.playerSession.get('/action-cards/catalog')).body;
  const existingHand = (await seller.playerSession.get('/action-cards/hand')).body.map((c) => c.action_card_id);
  const anotherCard = catalog.find((c) => !existingHand.includes(c.id));
  await seller.playerSession.post('/action-cards/request', { actionCardId: anotherCard.id, requestId: requestId() });
  const hand = await seller.playerSession.get('/action-cards/hand');
  const newHeld = hand.body.find((c) => c.status === 'held' && c.action_card_id === anotherCard.id);

  const list = await seller.playerSession.post('/market/list', { teamActionCardId: newHeld.id, requestId: requestId() });
  const unlist = await seller.playerSession.post('/market/unlist', { listingId: list.body.id, requestId: requestId() });
  assert.equal(unlist.status, 200);

  const handAfter = await seller.playerSession.get('/action-cards/hand');
  assert.equal(handAfter.body.find((c) => c.id === newHeld.id).status, 'held');
});
