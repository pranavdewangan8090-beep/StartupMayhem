import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Session, loadCredentials, pick } from './helpers.js';
import { deleteTestTeam, closePool } from './db.js';

const creds = loadCredentials();
let superAdmin, teamA, teamB, playerA, playerB, savedToggles;

before(async () => {
  superAdmin = new Session();
  const sa = pick(creds, 'super_admin');
  await superAdmin.login('super_admin', sa.loginId, sa.password);

  const toggles = await superAdmin.rpc('fn_super_toggles_get');
  savedToggles = { r2_selection_open: toggles.r2_selection_open, card_play_open: toggles.card_play_open };
  await superAdmin.rpc('fn_super_toggles_set', { p_key: 'r2_selection_open', p_value: true });
  await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: true });

  teamA = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-AC-A-${Date.now()}` });
  teamB = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-AC-B-${Date.now()}` });
  playerA = new Session();
  await playerA.login('player', teamA.teamCode, teamA.password);
  playerB = new Session();
  await playerB.login('player', teamB.teamCode, teamB.password);
});

after(async () => {
  await superAdmin.rpc('fn_super_toggles_set', { p_key: 'r2_selection_open', p_value: savedToggles.r2_selection_open });
  await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: savedToggles.card_play_open });
  await deleteTestTeam(teamA.teamId);
  await deleteTestTeam(teamB.teamId);
  await closePool();
});

function randomId() {
  return crypto.randomUUID();
}

describe('action card catalog + hand (read-only)', () => {
  test('catalog has all 3 categories and only the curated columns', async () => {
    const catalog = await playerA.rpc('fn_action_card_catalog');
    const categories = new Set(catalog.map((c) => c.category));
    assert.deepEqual([...categories].sort(), ['action', 'deal', 'special']);
    assert.equal(catalog[0].self_effect, undefined, 'raw effect JSON should not be exposed pre-reveal');
  });

  test('a fresh team has an empty hand', async () => {
    assert.deepEqual(await playerA.rpc('fn_player_hand'), []);
  });

  test('fn_other_teams excludes the caller\'s own team', async () => {
    const others = await playerA.rpc('fn_other_teams');
    assert.ok(!others.some((t) => t.id === teamA.teamId));
    assert.ok(others.some((t) => t.id === teamB.teamId));
  });
});

describe('requesting + playing action cards', () => {
  test('request one card of each category, then hit the cap', async () => {
    const catalog = await playerA.rpc('fn_action_card_catalog');
    for (const cat of ['action', 'deal', 'special']) {
      const card = catalog.find((c) => c.category === cat);
      const held = await playerA.rpc('fn_r2_request_card', { p_action_card_id: card.id, p_request_id: randomId() });
      assert.equal(held.status, 'held');
    }
    const hand = await playerA.rpc('fn_player_hand');
    assert.equal(hand.length, 3);

    // any 4th card, even a brand-new category-violating one, is now over cap
    const anyCard = catalog[0];
    await assert.rejects(
      () => playerA.rpc('fn_r2_request_card', { p_action_card_id: anyCard.id, p_request_id: randomId() }),
      (err) => err.message === 'R2_LIMIT_REACHED'
    );
  });

  test('a second card from an already-held category is rejected', async () => {
    const catalog = await playerB.rpc('fn_action_card_catalog');
    const actionCards = catalog.filter((c) => c.category === 'action');
    await playerB.rpc('fn_r2_request_card', { p_action_card_id: actionCards[0].id, p_request_id: randomId() });
    await assert.rejects(
      () => playerB.rpc('fn_r2_request_card', { p_action_card_id: actionCards[1].id, p_request_id: randomId() }),
      (err) => err.message === 'CATEGORY_ALREADY_TAKEN'
    );
  });

  test('the same request_id is never applied twice', async () => {
    const catalog = await playerB.rpc('fn_action_card_catalog');
    const dealCard = catalog.find((c) => c.category === 'deal');
    const reqId = randomId();
    await playerB.rpc('fn_r2_request_card', { p_action_card_id: dealCard.id, p_request_id: reqId });
    await assert.rejects(
      () => playerB.rpc('fn_r2_request_card', { p_action_card_id: dealCard.id, p_request_id: reqId }),
      (err) => err.message === 'DUPLICATE_REQUEST'
    );
  });

  test('playing an action/special card applies its effect and marks it used', async () => {
    const hand = await playerA.rpc('fn_player_hand');
    const actionOrSpecial = hand.find((c) => c.category === 'action' || c.category === 'special');
    const result = await playerA.rpc('fn_play_self_card', { p_team_action_card_id: actionOrSpecial.id, p_request_id: randomId() });
    assert.ok(result.before);
    assert.ok(result.after);

    const handAfter = await playerA.rpc('fn_player_hand');
    assert.equal(handAfter.find((c) => c.id === actionOrSpecial.id).status, 'used');
  });

  test('a deal card proposes to a partner, who can accept it', async () => {
    const hand = await playerA.rpc('fn_player_hand');
    const dealCard = hand.find((c) => c.category === 'deal' && c.status === 'held');
    const play = await playerA.rpc('fn_play_deal_card', {
      p_team_action_card_id: dealCard.id, p_partner_team_id: teamB.teamId, p_request_id: randomId(),
    });
    assert.equal(play.status, 'pending');

    const incoming = await playerB.rpc('fn_deals_incoming');
    const offer = incoming.find((d) => d.id === play.id || String(d.id) === String(play.id));
    assert.ok(offer, 'partner should see the pending offer');

    const result = await playerB.rpc('fn_respond_deal_card', { p_card_play_id: play.id, p_accept: true, p_request_id: randomId() });
    assert.equal(result.accepted, true);
    assert.ok(result.initiator_after);
    assert.ok(result.partner_after);
  });

  test('cannot target your own team with a deal card', async () => {
    const hand = await playerB.rpc('fn_player_hand');
    const dealCard = hand.find((c) => c.category === 'deal' && c.status === 'held');
    await assert.rejects(
      () => playerB.rpc('fn_play_deal_card', { p_team_action_card_id: dealCard.id, p_partner_team_id: teamB.teamId, p_request_id: randomId() }),
      (err) => err.message === 'CANNOT_TARGET_SELF'
    );
  });
});
