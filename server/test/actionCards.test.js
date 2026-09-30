// Teams no longer request action cards — fn_super_add_team auto-issues one
// random card per category (action/deal/special) at creation time, so a
// fresh team's hand is already full when a player first logs in.
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
  savedToggles = { card_play_open: toggles.card_play_open };
  await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: true });

  teamA = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-AC-A-${Date.now()}` });
  teamB = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-AC-B-${Date.now()}` });
  playerA = new Session();
  await playerA.login('player', teamA.loginId, teamA.password);
  playerB = new Session();
  await playerB.login('player', teamB.loginId, teamB.password);
});

after(async () => {
  await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: savedToggles.card_play_open });
  await deleteTestTeam(teamA.teamId);
  await deleteTestTeam(teamB.teamId);
  await closePool();
});

function randomId() {
  return crypto.randomUUID();
}

describe('starting hand (auto-issued, no request step)', () => {
  test('a freshly created team already holds one card per category', async () => {
    const hand = await playerA.rpc('fn_player_hand');
    assert.equal(hand.length, 3);
    assert.deepEqual([...new Set(hand.map((c) => c.category))].sort(), ['action', 'deal', 'special']);
    assert.ok(hand.every((c) => c.status === 'held'));
  });

  test('fn_other_teams excludes the caller\'s own team', async () => {
    const others = await playerA.rpc('fn_other_teams');
    assert.ok(!others.some((t) => t.id === teamA.teamId));
    assert.ok(others.some((t) => t.id === teamB.teamId));
  });
});

describe('playing action cards', () => {
  test('playing an action/special card applies its effect and marks it used', async () => {
    const hand = await playerA.rpc('fn_player_hand');
    const actionOrSpecial = hand.find((c) => c.category === 'action' || c.category === 'special');
    const result = await playerA.rpc('fn_play_self_card', { p_team_action_card_id: actionOrSpecial.id, p_request_id: randomId() });
    assert.ok(result.before);
    assert.ok(result.after);

    const handAfter = await playerA.rpc('fn_player_hand');
    assert.equal(handAfter.find((c) => c.id === actionOrSpecial.id).status, 'used');
  });

  test('cannot target your own team with a deal card', async () => {
    const hand = await playerB.rpc('fn_player_hand');
    const dealCard = hand.find((c) => c.category === 'deal' && c.status === 'held');
    await assert.rejects(
      () => playerB.rpc('fn_play_deal_card', { p_team_action_card_id: dealCard.id, p_partner_team_id: teamB.teamId, p_request_id: randomId() }),
      (err) => err.message === 'CANNOT_TARGET_SELF'
    );
  });

  // Regression: card_plays used to have UNIQUE(team_action_card_id), so a
  // rejected deal card went back to 'held' but could never be proposed again.
  test('a rejected deal card can be proposed again, and the proposer can withdraw an offer', async () => {
    const hand = await playerB.rpc('fn_player_hand');
    const dealCard = hand.find((c) => c.category === 'deal' && c.status === 'held');

    const first = await playerB.rpc('fn_play_deal_card', {
      p_team_action_card_id: dealCard.id, p_partner_team_id: teamA.teamId, p_request_id: randomId(),
    });
    const rejected = await playerA.rpc('fn_respond_deal_card', { p_card_play_id: first.id, p_accept: false, p_request_id: randomId() });
    assert.equal(rejected.accepted, false);

    const second = await playerB.rpc('fn_play_deal_card', {
      p_team_action_card_id: dealCard.id, p_partner_team_id: teamA.teamId, p_request_id: randomId(),
    });
    assert.equal(second.status, 'pending');

    const outgoing = await playerB.rpc('fn_deals_outgoing');
    assert.ok(outgoing.some((d) => String(d.id) === String(second.id)), 'proposer should see its own pending offer');

    await playerB.rpc('fn_cancel_deal_card', { p_card_play_id: second.id });
    const handAfter = await playerB.rpc('fn_player_hand');
    assert.equal(handAfter.find((c) => c.id === dealCard.id).status, 'held');

    await assert.rejects(
      () => playerA.rpc('fn_respond_deal_card', { p_card_play_id: second.id, p_accept: true, p_request_id: randomId() }),
      (err) => err.message === 'DEAL_ALREADY_RESOLVED'
    );
  });

  test('only the proposer can withdraw an offer', async () => {
    const hand = await playerB.rpc('fn_player_hand');
    const dealCard = hand.find((c) => c.category === 'deal' && c.status === 'held');
    const play = await playerB.rpc('fn_play_deal_card', {
      p_team_action_card_id: dealCard.id, p_partner_team_id: teamA.teamId, p_request_id: randomId(),
    });
    await assert.rejects(
      () => playerA.rpc('fn_cancel_deal_card', { p_card_play_id: play.id }),
      (err) => err.message === 'DEAL_NOT_FOUND'
    );
    await playerB.rpc('fn_cancel_deal_card', { p_card_play_id: play.id });
  });

  // Runs last in this describe block — it's the only test here that
  // actually completes a deal, and since server/sql/027_round_mechanics.sql
  // both teams' deal cards are consumed on accept (not just the
  // initiator's), so nothing after this can rely on playerA/playerB still
  // holding their original deal card.
  test('a deal card proposes to a partner, who can accept it (both cards consumed)', async () => {
    const handABefore = await playerA.rpc('fn_player_hand');
    const handBBefore = await playerB.rpc('fn_player_hand');
    const dealCardA = handABefore.find((c) => c.category === 'deal' && c.status === 'held');
    const dealCardB = handBBefore.find((c) => c.category === 'deal' && c.status === 'held');

    const play = await playerA.rpc('fn_play_deal_card', {
      p_team_action_card_id: dealCardA.id, p_partner_team_id: teamB.teamId, p_request_id: randomId(),
    });
    assert.equal(play.status, 'pending');

    const incoming = await playerB.rpc('fn_deals_incoming');
    const offer = incoming.find((d) => d.id === play.id || String(d.id) === String(play.id));
    assert.ok(offer, 'partner should see the pending offer');

    const result = await playerB.rpc('fn_respond_deal_card', { p_card_play_id: play.id, p_accept: true, p_request_id: randomId() });
    assert.equal(result.accepted, true);
    assert.ok(result.initiator_after);
    assert.ok(result.partner_after);

    const handAAfter = await playerA.rpc('fn_player_hand');
    const handBAfter = await playerB.rpc('fn_player_hand');
    assert.equal(handAAfter.find((c) => c.id === dealCardA.id).status, 'used', 'initiator\'s deal card should be used');
    assert.equal(handBAfter.find((c) => c.id === dealCardB.id).status, 'used', 'partner\'s own deal card should ALSO be used — deals are paired');
  });
});
