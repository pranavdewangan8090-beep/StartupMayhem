// Full feature coverage: one test file that exercises every RPC function the
// client actually calls (see the list below — cross-checked by grepping
// client/src for every `supabase.rpc('fn_...')` call site), so a change that
// breaks ANY feature shows up here, not just in whichever narrower test file
// happens to cover it. This complements, not replaces, the other test files
// (which go deeper on individual edge cases) — this one's job is breadth:
// walk every real user-facing flow once, top to bottom.
//
// Functions covered (36 — every fn_* the client calls):
//   fn_login, fn_auth_user
//   fn_player_cards, fn_replace_identity_card, fn_player_hand, fn_other_teams,
//   fn_play_self_card, fn_play_deal_card, fn_respond_deal_card,
//   fn_cancel_deal_card, fn_deals_incoming, fn_deals_outgoing,
//   fn_player_state, fn_player_status, fn_crisis_public
//   fn_admin_teams, fn_admin_team_cards, fn_admin_crisis_list,
//   fn_admin_crisis_effects, fn_admin_process_trade
//   fn_super_toggles_get, fn_super_toggles_set, fn_super_add_team,
//   fn_super_deactivate_team, fn_super_reactivate_team,
//   fn_super_reset_password, fn_super_accounts, fn_admin_adjust_resources,
//   fn_admin_adjust_decision_points, fn_super_mark_mission,
//   fn_super_leaderboard_raw, fn_super_trigger_crisis (role check only —
//   never actually fired, it's shared one-shot event-day state),
//   fn_trade_feature_status, fn_super_trade_toggle_set,
//   fn_super_trade_toggles_all, fn_super_merge_teams, fn_super_team_merges
//
// Safety model matches the rest of the suite: every mutation happens on
// disposable TEST-... teams created via fn_super_add_team and hard-deleted
// afterward; any global toggle this file changes is read first and restored
// after; the real 30 seeded teams and staff accounts are never touched.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Session, loadCredentials, pick } from './helpers.js';
import { query, deleteTestTeam, closePool } from './db.js';

const creds = loadCredentials();
const rid = () => crypto.randomUUID();

let superAdmin, admin;
let savedToggles; // { r1_replace_open, card_play_open }
let savedMyTrade; // this super_admin's own trade-toggle row, restored after

before(async () => {
  superAdmin = new Session();
  const sa = pick(creds, 'super_admin');
  await superAdmin.login('super_admin', sa.loginId, sa.password);

  admin = new Session();
  const ac = pick(creds, 'admin');
  await admin.login('admin', ac.loginId, ac.password);

  const toggles = await superAdmin.rpc('fn_super_toggles_get');
  savedToggles = { r1_replace_open: toggles.r1_replace_open, card_play_open: toggles.card_play_open };
  await superAdmin.rpc('fn_super_toggles_set', { p_key: 'r1_replace_open', p_value: true });
  await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: true });

  const tradeStatus = await superAdmin.rpc('fn_trade_feature_status');
  savedMyTrade = tradeStatus[0].mine;
  await superAdmin.rpc('fn_super_trade_toggle_set', { p_enabled: true });
});

after(async () => {
  await superAdmin.rpc('fn_super_toggles_set', { p_key: 'r1_replace_open', p_value: savedToggles.r1_replace_open });
  await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: savedToggles.card_play_open });
  await superAdmin.rpc('fn_super_trade_toggle_set', { p_enabled: savedMyTrade });
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. Auth
// ---------------------------------------------------------------------------
describe('1. Auth (fn_login, fn_auth_user)', () => {
  test('each role logs in and resolves its own identity', async () => {
    const saMe = (await superAdmin.rpc('fn_auth_user'))[0];
    assert.equal(saMe.app_role, 'super_admin');
    const adMe = (await admin.rpc('fn_auth_user'))[0];
    assert.equal(adMe.app_role, 'admin');
  });

  test('wrong password and unknown login both report the same generic error', async () => {
    // Use a disposable team for the wrong-password case, never a real
    // account — fn_login's rate limiter (015_login_rate_limit.sql) counts
    // failures per (role, login_id), and running this file repeatedly
    // against a REAL super_admin/admin login would eventually rate-limit
    // that real account (breaking its actual login, not just this test).
    const team = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-BADPW-${Date.now()}` });
    try {
      await assert.rejects(
        () => new Session().login('player', team.loginId, 'definitely-wrong'),
        (err) => err.message === 'INVALID_CREDENTIALS'
      );
      await assert.rejects(
        () => new Session().login('player', 'NO-SUCH-LOGIN-ID', 'x'),
        (err) => err.message === 'INVALID_CREDENTIALS'
      );
    } finally {
      await deleteTestTeam(team.teamId);
    }
  });

  test('an unauthenticated caller cannot call fn_auth_user', async () => {
    await assert.rejects(
      () => new Session().rpc('fn_auth_user'),
      (err) => err.status === 401
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Security lockdown — anon can reach nothing but fn_login
// ---------------------------------------------------------------------------
describe('2. Security lockdown', () => {
  test('anon cannot call fn_current_jwt_secret, fn_super_accounts, fn_admin_teams, or fn_player_cards', async () => {
    const anon = new Session();
    for (const fn of ['fn_current_jwt_secret', 'fn_super_accounts', 'fn_admin_teams', 'fn_player_cards']) {
      await assert.rejects(() => anon.rpc(fn), (err) => err.status === 401, `${fn} should be unreachable by anon`);
    }
  });

  test('a player cannot call admin or super_admin functions', async () => {
    const teamCred = pick(creds, 'player');
    const player = new Session();
    await player.login('player', teamCred.loginId, teamCred.password);
    await assert.rejects(() => player.rpc('fn_admin_teams'), (err) => err.message === 'NOT_AUTHENTICATED');
    await assert.rejects(() => player.rpc('fn_super_toggles_get'), (err) => err.message === 'NOT_AUTHENTICATED');
  });

  test('an admin cannot call super_admin-only functions', async () => {
    await assert.rejects(
      () => admin.rpc('fn_admin_adjust_resources', { p_team_id: 1, p_delta: { cash_l: 1 } }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
    await assert.rejects(() => admin.rpc('fn_super_trigger_crisis', { p_crisis_id: 1 }), (err) => err.message === 'NOT_AUTHENTICATED');
    await assert.rejects(() => admin.rpc('fn_super_merge_teams', { p_team_a_id: 1, p_team_b_id: 2 }), (err) => err.message === 'NOT_AUTHENTICATED');
  });
});

// ---------------------------------------------------------------------------
// 3. Player: identity cards (Round 1) + starting hand + card supply
// ---------------------------------------------------------------------------
describe('3. Player identity cards & starting hand', () => {
  let team, player;

  before(async () => {
    team = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-CARDS-${Date.now()}` });
    player = new Session();
    await player.login('player', team.loginId, team.password);
  });

  after(async () => { await deleteTestTeam(team.teamId); });

  test('fn_player_cards returns all 4 identity cards with 0 replacements used', async () => {
    const cards = (await player.rpc('fn_player_cards'))[0];
    assert.ok(cards.market_title && cards.customer_title && cards.mission_title && cards.resources_title);
    assert.equal(cards.replacements_used, 0);
  });

  test('fn_replace_identity_card swaps the card, and replacing Resources resets live resources', async () => {
    const before = (await player.rpc('fn_player_cards'))[0];
    const replaced = await player.rpc('fn_replace_identity_card', { p_category: 'resources' });
    const after = (await player.rpc('fn_player_cards'))[0];
    assert.notEqual(after.resources_id, before.resources_id);
    assert.equal(after.replacements_used, 1);
    assert.equal(after.cash_l, replaced.start_cash_l);
    assert.equal(after.customers, replaced.start_customers);
  });

  test('the 3-replacement cap is enforced', async () => {
    await player.rpc('fn_replace_identity_card', { p_category: 'market' });
    await player.rpc('fn_replace_identity_card', { p_category: 'customer' });
    await assert.rejects(
      () => player.rpc('fn_replace_identity_card', { p_category: 'mission' }),
      (err) => err.message === 'REPLACEMENT_LIMIT_REACHED'
    );
  });

  test('fn_player_hand starts with exactly one card per category, and fn_other_teams excludes the caller', async () => {
    const hand = await player.rpc('fn_player_hand');
    assert.equal(hand.length, 3);
    assert.deepEqual([...new Set(hand.map((c) => c.category))].sort(), ['action', 'deal', 'special']);

    const others = await player.rpc('fn_other_teams');
    assert.ok(!others.some((t) => t.id === team.teamId));
  });

  test('no specific card is issued to more than 3 teams (027 card supply cap)', async () => {
    const { rows } = await query(
      `select action_card_id, count(*) as n from team_action_cards group by action_card_id having count(*) > 3`
    );
    assert.deepEqual(rows, [], `these cards exceed the 3-copy cap: ${JSON.stringify(rows)}`);
  });
});

// ---------------------------------------------------------------------------
// 4. Player: playing self cards + card_play_open gating
// ---------------------------------------------------------------------------
describe('4. Playing Special/Action cards', () => {
  let team, player;

  before(async () => {
    team = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-SELF-${Date.now()}` });
    player = new Session();
    await player.login('player', team.loginId, team.password);
    // fn_player_hand doesn't expose a card's self_effect, so there's no way
    // to pick an affordable one client-side — top up cash instead, so which
    // card was randomly dealt never determines whether this test passes
    // (a real, low-starting-cash team hitting INSUFFICIENT_CASH on a
    // costly card is correct app behavior, not something to test here)
    await superAdmin.rpc('fn_admin_adjust_resources', { p_team_id: team.teamId, p_delta: { cash_l: 100 } });
  });

  after(async () => { await deleteTestTeam(team.teamId); });

  test('playing an action/special card applies its effect and is reflected in fn_player_state', async () => {
    const hand = await player.rpc('fn_player_hand');
    const card = hand.find((c) => c.category === 'action' || c.category === 'special');
    const result = await player.rpc('fn_play_self_card', { p_team_action_card_id: card.id, p_request_id: rid() });
    assert.ok(result.before && result.after);

    const state = (await player.rpc('fn_player_state'))[0];
    assert.equal(Number(state.used_card_count), 1);

    const status = (await player.rpc('fn_player_status'))[0];
    assert.equal(status.cash_l, result.after.cash_l);
  });

  test('a deal card cannot be played as a self card', async () => {
    const hand = await player.rpc('fn_player_hand');
    const dealCard = hand.find((c) => c.category === 'deal');
    await assert.rejects(
      () => player.rpc('fn_play_self_card', { p_team_action_card_id: dealCard.id, p_request_id: rid() }),
      (err) => err.message === 'WRONG_CARD_TYPE'
    );
  });

  test('respects the card_play_open toggle', async () => {
    await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: false });
    try {
      const hand = await player.rpc('fn_player_hand');
      const remaining = hand.find((c) => c.status === 'held' && (c.category === 'action' || c.category === 'special'));
      await assert.rejects(
        () => player.rpc('fn_play_self_card', { p_team_action_card_id: remaining.id, p_request_id: rid() }),
        (err) => err.message === 'CARD_PLAY_CLOSED'
      );
    } finally {
      await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Player: deal cards — propose, accept (paired), reject, cancel, expiry
// ---------------------------------------------------------------------------
// Tests run in this exact order because deal cards are consumed as the
// block progresses (there's no "reset" between tests in a describe block).
// Layout: A and C cycle a card through propose/reject/withdraw/duplicate —
// operations that always return it to 'held' — so both stay untouched right
// up until the final pairing test, which deliberately consumes B and C's
// cards. That leaves A (still held) as the one team the "no card available"
// test can aim at B or C with. A fourth team, D, exists purely for the
// expiry test so it doesn't need to borrow a card from anyone else's story.
describe('5. Deal cards', () => {
  let teamA, teamB, teamC, teamD, playerA, playerB, playerC, playerD;

  before(async () => {
    teamA = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-DEAL-A-${Date.now()}` });
    teamB = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-DEAL-B-${Date.now()}` });
    teamC = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-DEAL-C-${Date.now()}` });
    teamD = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-DEAL-D-${Date.now()}` });
    playerA = new Session(); await playerA.login('player', teamA.loginId, teamA.password);
    playerB = new Session(); await playerB.login('player', teamB.loginId, teamB.password);
    playerC = new Session(); await playerC.login('player', teamC.loginId, teamC.password);
    playerD = new Session(); await playerD.login('player', teamD.loginId, teamD.password);
    // same reasoning as section 4 — some deal cards cost real Cash on
    // either side, and a paired deal can land costs from both cards on one
    // team, so top up everyone rather than let a random low-cash deal make
    // this test flaky
    for (const t of [teamA, teamB, teamC, teamD]) {
      await superAdmin.rpc('fn_admin_adjust_resources', { p_team_id: t.teamId, p_delta: { cash_l: 100 } });
    }
  });

  after(async () => {
    await deleteTestTeam(teamA.teamId);
    await deleteTestTeam(teamB.teamId);
    await deleteTestTeam(teamC.teamId);
    await deleteTestTeam(teamD.teamId);
  });

  test('1. cannot target your own team', async () => {
    const hand = await playerA.rpc('fn_player_hand');
    const deal = hand.find((c) => c.category === 'deal');
    await assert.rejects(
      () => playerA.rpc('fn_play_deal_card', { p_team_action_card_id: deal.id, p_partner_team_id: teamA.teamId, p_request_id: rid() }),
      (err) => err.message === 'CANNOT_TARGET_SELF'
    );
  });

  test('2. propose → reject returns the card to held, and it can be re-proposed then cancelled', async () => {
    const handA = await playerA.rpc('fn_player_hand');
    const dealA = handA.find((c) => c.category === 'deal');

    const first = await playerA.rpc('fn_play_deal_card', { p_team_action_card_id: dealA.id, p_partner_team_id: teamC.teamId, p_request_id: rid() });
    const incoming = await playerC.rpc('fn_deals_incoming');
    assert.ok(incoming.some((d) => String(d.id) === String(first.id)));

    const rejected = await playerC.rpc('fn_respond_deal_card', { p_card_play_id: first.id, p_accept: false, p_request_id: rid() });
    assert.equal(rejected.accepted, false);
    assert.equal((await playerA.rpc('fn_player_hand')).find((c) => c.id === dealA.id).status, 'held');

    const second = await playerA.rpc('fn_play_deal_card', { p_team_action_card_id: dealA.id, p_partner_team_id: teamC.teamId, p_request_id: rid() });
    assert.equal(second.status, 'pending');
    await playerA.rpc('fn_cancel_deal_card', { p_card_play_id: second.id });
    assert.equal((await playerA.rpc('fn_player_hand')).find((c) => c.id === dealA.id).status, 'held');
  });

  test('3. only the proposer can withdraw an offer, and fn_deals_outgoing shows it to them', async () => {
    const handA = await playerA.rpc('fn_player_hand');
    const dealA = handA.find((c) => c.category === 'deal');
    const play = await playerA.rpc('fn_play_deal_card', { p_team_action_card_id: dealA.id, p_partner_team_id: teamC.teamId, p_request_id: rid() });

    const outgoing = await playerA.rpc('fn_deals_outgoing');
    assert.ok(outgoing.some((d) => String(d.id) === String(play.id)));

    await assert.rejects(
      () => playerC.rpc('fn_cancel_deal_card', { p_card_play_id: play.id }),
      (err) => err.message === 'DEAL_NOT_FOUND'
    );
    await playerA.rpc('fn_cancel_deal_card', { p_card_play_id: play.id });
    assert.equal((await playerA.rpc('fn_player_hand')).find((c) => c.id === dealA.id).status, 'held');
  });

  test('4. a duplicate request_id is rejected, and the offer is cleared back to held afterward', async () => {
    const requestId = rid();
    const handA = await playerA.rpc('fn_player_hand');
    const dealA = handA.find((c) => c.category === 'deal' && c.status === 'held');
    const play = await playerA.rpc('fn_play_deal_card', { p_team_action_card_id: dealA.id, p_partner_team_id: teamC.teamId, p_request_id: requestId });
    await assert.rejects(
      () => playerA.rpc('fn_play_deal_card', { p_team_action_card_id: dealA.id, p_partner_team_id: teamC.teamId, p_request_id: requestId }),
      (err) => err.message === 'DUPLICATE_REQUEST'
    );
    // leave A and C both 'held' again for the tests after this one
    await playerC.rpc('fn_respond_deal_card', { p_card_play_id: play.id, p_accept: false, p_request_id: rid() });
    assert.equal((await playerA.rpc('fn_player_hand')).find((c) => c.id === dealA.id).status, 'held');
  });

  test('5. a pending offer auto-expires after its TTL', async () => {
    const handA = await playerA.rpc('fn_player_hand');
    const dealA = handA.find((c) => c.category === 'deal' && c.status === 'held');
    const play = await playerA.rpc('fn_play_deal_card', { p_team_action_card_id: dealA.id, p_partner_team_id: teamD.teamId, p_request_id: rid() });

    // fast-forward past the 2-minute TTL directly in the DB rather than
    // sleeping the test for real
    await query(`update card_plays set created_at = now() - interval '3 minutes' where id = $1`, [play.id]);

    const incoming = await playerD.rpc('fn_deals_incoming'); // lazily expires stale offers
    assert.ok(!incoming.some((d) => String(d.id) === String(play.id)));
    assert.equal((await playerA.rpc('fn_player_hand')).find((c) => c.id === dealA.id).status, 'held', 'the card should have returned to held on expiry');

    await assert.rejects(
      () => playerD.rpc('fn_respond_deal_card', { p_card_play_id: play.id, p_accept: true, p_request_id: rid() }),
      (err) => err.message === 'DEAL_ALREADY_RESOLVED'
    );
  });

  test('6. accepting pairs both cards: both consumed, both sides’ resources move', async () => {
    const handBBefore = await playerB.rpc('fn_player_hand');
    const handCBefore = await playerC.rpc('fn_player_hand');
    const dealB = handBBefore.find((c) => c.category === 'deal');
    const dealC = handCBefore.find((c) => c.category === 'deal');
    const statusBBefore = (await playerB.rpc('fn_player_status'))[0];
    const statusCBefore = (await playerC.rpc('fn_player_status'))[0];

    const play = await playerB.rpc('fn_play_deal_card', { p_team_action_card_id: dealB.id, p_partner_team_id: teamC.teamId, p_request_id: rid() });
    const result = await playerC.rpc('fn_respond_deal_card', { p_card_play_id: play.id, p_accept: true, p_request_id: rid() });
    assert.equal(result.accepted, true);

    assert.equal((await playerB.rpc('fn_player_hand')).find((c) => c.id === dealB.id).status, 'used');
    assert.equal((await playerC.rpc('fn_player_hand')).find((c) => c.id === dealC.id).status, 'used', 'the responder’s own deal card must also be consumed');

    const statusBAfter = (await playerB.rpc('fn_player_status'))[0];
    const statusCAfter = (await playerC.rpc('fn_player_status'))[0];
    const changed = (b, a) => ['cash_l', 'customers', 'reputation', 'innovation'].some((k) => b[k] !== a[k]);
    assert.ok(changed(statusBBefore, statusBAfter) || changed(statusCBefore, statusCAfter));
  });

  test('7. cannot propose to a team with no held deal card of their own', async () => {
    // teamC's deal card was just consumed above; A's is still held from
    // test 4's cleanup
    const handA = await playerA.rpc('fn_player_hand');
    const dealA = handA.find((c) => c.category === 'deal' && c.status === 'held');
    await assert.rejects(
      () => playerA.rpc('fn_play_deal_card', { p_team_action_card_id: dealA.id, p_partner_team_id: teamC.teamId, p_request_id: rid() }),
      (err) => err.message === 'PARTNER_HAS_NO_DEAL_CARD'
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Crisis (read paths — never actually triggered here; it's shared,
//    one-shot, sequential event-day state)
// ---------------------------------------------------------------------------
describe('6. Crisis read paths', () => {
  test('fn_crisis_public returns tier_deltas for every tier and no team lists', async () => {
    const teamCred = pick(creds, 'player');
    const player = new Session();
    await player.login('player', teamCred.loginId, teamCred.password);

    const rows = await player.rpc('fn_crisis_public');
    assert.ok(Array.isArray(rows));
    for (const row of rows) {
      assert.ok('tier_deltas' in row);
      assert.ok(!('hit_hard_teams' in row));
      if (row.tier_deltas) {
        for (const tier of ['hit_hard', 'hit', 'unaffected', 'gains']) assert.ok(tier in row.tier_deltas);
      }
    }
  });

  test('fn_admin_crisis_list / fn_admin_crisis_effects are admin+ only', async () => {
    const list = await admin.rpc('fn_admin_crisis_list');
    assert.ok(Array.isArray(list));
    if (list.length > 0) {
      const effects = await admin.rpc('fn_admin_crisis_effects', { p_crisis_id: list[0].id });
      assert.ok(Array.isArray(effects));
    }

    const teamCred = pick(creds, 'player');
    const player = new Session();
    await player.login('player', teamCred.loginId, teamCred.password);
    await assert.rejects(() => player.rpc('fn_admin_crisis_list'), (err) => err.message === 'NOT_AUTHENTICATED');
  });

  test('only super_admin may trigger the next crisis (never actually fired here)', async () => {
    await assert.rejects(
      () => admin.rpc('fn_super_trigger_crisis', { p_crisis_id: 1 }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Admin: trading
// ---------------------------------------------------------------------------
describe('7. Admin-processed trading', () => {
  let teamA, teamB;

  before(async () => {
    teamA = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-TRADE-A-${Date.now()}` });
    teamB = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-TRADE-B-${Date.now()}` });
  });

  after(async () => {
    await deleteTestTeam(teamA.teamId);
    await deleteTestTeam(teamB.teamId);
  });

  test('fn_admin_teams and fn_admin_team_cards list the disposable teams and their hands', async () => {
    const teams = await admin.rpc('fn_admin_teams');
    assert.ok(teams.some((t) => t.id === teamA.teamId));

    const cardsA = await admin.rpc('fn_admin_team_cards', { p_team_id: teamA.teamId });
    assert.equal(cardsA.length, 3);
  });

  test('admin can swap two held non-deal cards between teams', async () => {
    const cardsA = await admin.rpc('fn_admin_team_cards', { p_team_id: teamA.teamId });
    const cardsB = await admin.rpc('fn_admin_team_cards', { p_team_id: teamB.teamId });
    const heldA = cardsA.find((c) => c.category === 'action' && c.status === 'held');
    const heldB = cardsB.find((c) => c.category === 'action' && c.status === 'held');

    const result = await admin.rpc('fn_admin_process_trade', {
      p_team_a_id: teamA.teamId, p_team_a_card_id: heldA.id,
      p_team_b_id: teamB.teamId, p_team_b_card_id: heldB.id,
      p_money_team_id: null, p_money_amount: 0, p_crisis_id: null, p_request_id: rid(),
    });
    assert.ok(result.teamACardId);

    const cardsAAfter = await admin.rpc('fn_admin_team_cards', { p_team_id: teamA.teamId });
    assert.ok(cardsAAfter.some((c) => c.id === heldB.id));
  });

  test('a deal card can only be traded for another deal card', async () => {
    const cardsA = await admin.rpc('fn_admin_team_cards', { p_team_id: teamA.teamId });
    const cardsB = await admin.rpc('fn_admin_team_cards', { p_team_id: teamB.teamId });
    const dealA = cardsA.find((c) => c.category === 'deal' && c.status === 'held');
    const specialB = cardsB.find((c) => c.category === 'special' && c.status === 'held');

    await assert.rejects(
      () => admin.rpc('fn_admin_process_trade', {
        p_team_a_id: teamA.teamId, p_team_a_card_id: dealA.id,
        p_team_b_id: teamB.teamId, p_team_b_card_id: specialB.id,
        p_money_team_id: null, p_money_amount: 0, p_crisis_id: null, p_request_id: rid(),
      }),
      (err) => err.message === 'DEAL_TRADES_ONLY_WITH_DEAL'
    );
  });

  test('a used card cannot be traded', async () => {
    const teamC = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-TRADE-C-${Date.now()}` });
    try {
      const playerC = new Session();
      await playerC.login('player', teamC.loginId, teamC.password);
      const hand = await playerC.rpc('fn_player_hand');
      const toUse = hand.find((c) => c.category === 'action' || c.category === 'special');
      await playerC.rpc('fn_play_self_card', { p_team_action_card_id: toUse.id, p_request_id: rid() });

      // teamA always holds exactly one card per category (the earlier swap
      // test substituted its 'action' card for a different one, it never
      // removed a category), so a held card in toUse's category always exists
      const cardsA = await admin.rpc('fn_admin_team_cards', { p_team_id: teamA.teamId });
      const heldA = cardsA.find((c) => c.category === toUse.category && c.status === 'held');
      assert.ok(heldA, `teamA should still hold a ${toUse.category} card`);

      await assert.rejects(
        () => admin.rpc('fn_admin_process_trade', {
          p_team_a_id: teamA.teamId, p_team_a_card_id: heldA.id,
          p_team_b_id: teamC.teamId, p_team_b_card_id: toUse.id,
          p_money_team_id: null, p_money_amount: 0, p_crisis_id: null, p_request_id: rid(),
        }),
        (err) => err.message === 'CARD_NOT_AVAILABLE'
      );
    } finally {
      await deleteTestTeam(teamC.teamId);
    }
  });

  test('trading is refused while the feature is switched off', async () => {
    await superAdmin.rpc('fn_super_trade_toggle_set', { p_enabled: false });
    try {
      const cardsA = await admin.rpc('fn_admin_team_cards', { p_team_id: teamA.teamId });
      const cardsB = await admin.rpc('fn_admin_team_cards', { p_team_id: teamB.teamId });
      const heldA = cardsA.find((c) => c.status === 'held');
      const heldB = cardsB.find((c) => c.status === 'held');
      await assert.rejects(
        () => admin.rpc('fn_admin_process_trade', {
          p_team_a_id: teamA.teamId, p_team_a_card_id: heldA.id,
          p_team_b_id: teamB.teamId, p_team_b_card_id: heldB.id,
          p_money_team_id: null, p_money_amount: 0, p_crisis_id: null, p_request_id: rid(),
        }),
        (err) => err.message === 'TRADING_DISABLED'
      );
    } finally {
      await superAdmin.rpc('fn_super_trade_toggle_set', { p_enabled: true });
    }
  });

  test('fn_trade_feature_status / fn_super_trade_toggles_all reflect the toggle', async () => {
    const status = (await superAdmin.rpc('fn_trade_feature_status'))[0];
    assert.equal(status.enabled, true);
    assert.equal(status.mine, true);
    const all = await superAdmin.rpc('fn_super_trade_toggles_all');
    assert.ok(Array.isArray(all) && all.length > 0);
  });

  test('a player cannot process a trade', async () => {
    const teamCred = pick(creds, 'player');
    const player = new Session();
    await player.login('player', teamCred.loginId, teamCred.password);
    await assert.rejects(
      () => player.rpc('fn_admin_process_trade', {
        p_team_a_id: teamA.teamId, p_team_a_card_id: '00000000-0000-0000-0000-000000000000',
        p_team_b_id: teamB.teamId, p_team_b_card_id: '00000000-0000-0000-0000-000000000000',
        p_money_team_id: null, p_money_amount: 0, p_crisis_id: null, p_request_id: rid(),
      }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Super Admin: team & account management
// ---------------------------------------------------------------------------
describe('8. Super Admin team management', () => {
  test('add → list → deactivate → reactivate → reset password, end to end', async () => {
    const created = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-MGMT-${Date.now()}` });
    try {
      const accounts = await superAdmin.rpc('fn_super_accounts');
      const account = accounts.find((a) => a.team_id === created.teamId);
      assert.ok(account);
      assert.equal(account.login_id, created.loginId);
      assert.equal(account.team_active, true);

      await superAdmin.rpc('fn_super_deactivate_team', { p_team_id: created.teamId });
      const teamsAfterDeactivate = await superAdmin.rpc('fn_admin_teams');
      assert.ok(!teamsAfterDeactivate.some((t) => t.id === created.teamId));
      await assert.rejects(
        () => new Session().login('player', created.loginId, created.password),
        (err) => err.message === 'INVALID_CREDENTIALS'
      );

      await superAdmin.rpc('fn_super_reactivate_team', { p_team_id: created.teamId });
      const player = new Session();
      await player.login('player', created.loginId, created.password);
      assert.ok(player.token);

      const reset = await superAdmin.rpc('fn_super_reset_password', { p_user_id: account.user_id });
      assert.equal(reset.loginId, created.loginId);
      const playerNew = new Session();
      await playerNew.login('player', created.loginId, reset.password);
      assert.ok(playerNew.token);
      await assert.rejects(
        () => new Session().login('player', created.loginId, created.password),
        (err) => err.message === 'INVALID_CREDENTIALS'
      );
    } finally {
      await deleteTestTeam(created.teamId);
    }
  });

  test('deactivating a team withdraws its pending deal offers', async () => {
    const teamX = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-DEACT-X-${Date.now()}` });
    const teamY = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-DEACT-Y-${Date.now()}` });
    try {
      const playerX = new Session(); await playerX.login('player', teamX.loginId, teamX.password);
      const handX = await playerX.rpc('fn_player_hand');
      const dealX = handX.find((c) => c.category === 'deal');
      await playerX.rpc('fn_play_deal_card', { p_team_action_card_id: dealX.id, p_partner_team_id: teamY.teamId, p_request_id: rid() });

      await superAdmin.rpc('fn_super_deactivate_team', { p_team_id: teamY.teamId });

      const handXAfter = await playerX.rpc('fn_player_hand');
      assert.equal(handXAfter.find((c) => c.id === dealX.id).status, 'held', 'the offer should have been withdrawn, card returned to held');
    } finally {
      await deleteTestTeam(teamX.teamId);
      await deleteTestTeam(teamY.teamId);
    }
  });

  test('only super_admin can add/deactivate/reset a team', async () => {
    await assert.rejects(() => admin.rpc('fn_super_add_team', { p_team_code: 'SHOULD-FAIL' }), (err) => err.message === 'NOT_AUTHENTICATED');
    await assert.rejects(() => admin.rpc('fn_super_deactivate_team', { p_team_id: 1 }), (err) => err.message === 'NOT_AUTHENTICATED');
  });
});

// ---------------------------------------------------------------------------
// 9. Super Admin: resources, decision points, missions, leaderboard
// ---------------------------------------------------------------------------
describe('9. Resources, decision points, missions, leaderboard', () => {
  let team;

  before(async () => {
    team = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-SCORE-${Date.now()}` });
  });

  after(async () => { await deleteTestTeam(team.teamId); });

  test('fn_admin_adjust_resources clamps at the caps, super_admin only', async () => {
    const result = await superAdmin.rpc('fn_admin_adjust_resources', {
      p_team_id: team.teamId, p_delta: { cash_l: 5, reputation: 100 },
    });
    assert.equal(result.after.cash_l, result.before.cash_l + 5);
    assert.equal(result.after.reputation, 5);

    await assert.rejects(
      () => admin.rpc('fn_admin_adjust_resources', { p_team_id: team.teamId, p_delta: { cash_l: 1 } }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });

  test('fn_admin_adjust_decision_points accumulates, super_admin only', async () => {
    const result = await superAdmin.rpc('fn_admin_adjust_decision_points', { p_team_id: team.teamId, p_payload: { delta: 12 } });
    assert.equal(result.decision_points, 12);
    await assert.rejects(
      () => admin.rpc('fn_admin_adjust_decision_points', { p_team_id: team.teamId, p_payload: { delta: 1 } }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });

  test('fn_super_mark_mission flips mission_completed, reflected on the leaderboard', async () => {
    await superAdmin.rpc('fn_super_mark_mission', { p_team_id: team.teamId, p_completed: true });
    const leaderboard = await superAdmin.rpc('fn_super_leaderboard_raw');
    const row = leaderboard.find((r) => r.team_id === team.teamId);
    assert.equal(row.mission_completed, true);
    assert.ok('mission_title' in row);
    assert.equal(row.decision_points, 12);
  });
});

// ---------------------------------------------------------------------------
// 10. Super Admin: toggles
// ---------------------------------------------------------------------------
describe('10. Super Admin toggles', () => {
  test('fn_super_toggles_set round-trips and rejects an unknown key', async () => {
    const before = await superAdmin.rpc('fn_super_toggles_get');
    await superAdmin.rpc('fn_super_toggles_set', { p_key: 'r1_replace_open', p_value: !before.r1_replace_open });
    const after = await superAdmin.rpc('fn_super_toggles_get');
    assert.equal(after.r1_replace_open, !before.r1_replace_open);
    await superAdmin.rpc('fn_super_toggles_set', { p_key: 'r1_replace_open', p_value: before.r1_replace_open });

    await assert.rejects(
      () => superAdmin.rpc('fn_super_toggles_set', { p_key: 'not_a_real_toggle', p_value: true }),
      (err) => err.message === 'BAD_TOGGLE_KEY'
    );
  });

  test('an admin cannot flip toggles', async () => {
    await assert.rejects(
      () => admin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: true }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Super Admin: team merge (Round 5)
// ---------------------------------------------------------------------------
describe('11. Team merge', () => {
  test('averages resources, combines hands, both logins keep working, and CANNOT_MERGE_SAME_TEAM is enforced', async () => {
    const teamA = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-MERGE-A-${Date.now()}` });
    const teamB = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-FULL-MERGE-B-${Date.now()}` });
    const playerA = new Session(); await playerA.login('player', teamA.loginId, teamA.password);
    const playerB = new Session(); await playerB.login('player', teamB.loginId, teamB.password);

    const statusABefore = (await playerA.rpc('fn_player_status'))[0];
    const statusBBefore = (await playerB.rpc('fn_player_status'))[0];
    const handABefore = await playerA.rpc('fn_player_hand');
    const handBBefore = await playerB.rpc('fn_player_hand');

    await assert.rejects(
      () => superAdmin.rpc('fn_super_merge_teams', { p_team_a_id: teamA.teamId, p_team_b_id: teamA.teamId }),
      (err) => err.message === 'CANNOT_MERGE_SAME_TEAM'
    );

    const result = await superAdmin.rpc('fn_super_merge_teams', { p_team_a_id: teamA.teamId, p_team_b_id: teamB.teamId });
    assert.match(result.teamCode, /^TM\d{2,}$/);

    const meA = (await playerA.rpc('fn_auth_user'))[0];
    const meB = (await playerB.rpc('fn_auth_user'))[0];
    assert.equal(meA.team_id, result.mergedTeamId);
    assert.equal(meB.team_id, result.mergedTeamId, 'both original logins should now resolve to the merged team');

    const statusA = (await playerA.rpc('fn_player_status'))[0];
    assert.equal(statusA.cash_l, Math.round((statusABefore.cash_l + statusBBefore.cash_l) / 2));

    const mergedHand = await playerA.rpc('fn_player_hand');
    assert.equal(mergedHand.length, handABefore.length + handBBefore.length);

    const teams = await superAdmin.rpc('fn_admin_teams');
    assert.ok(!teams.some((t) => t.id === teamA.teamId) && !teams.some((t) => t.id === teamB.teamId));

    const merges = await superAdmin.rpc('fn_super_team_merges');
    assert.ok(merges.some((m) => m.merged_team_code === result.teamCode));

    await deleteTestTeam(result.mergedTeamId);
  });
});
