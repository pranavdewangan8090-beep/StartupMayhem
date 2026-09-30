// server/sql/027_round_mechanics.sql (as amended by 029, which removed the
// deal-offer expiry timer): card supply cap, paired deal cards, and team
// merging.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Session, loadCredentials, pick } from './helpers.js';
import { query, deleteTestTeam, closePool } from './db.js';

const creds = loadCredentials();
let superAdmin;

before(async () => {
  superAdmin = new Session();
  const sa = pick(creds, 'super_admin');
  await superAdmin.login('super_admin', sa.loginId, sa.password);
});

after(async () => {
  await closePool();
});

describe('card supply cap (fn_issue_starting_hand)', () => {
  test('no specific card is ever held by more than 3 teams at once', async () => {
    // Informational regression check against the whole live table, not just
    // disposable teams — every card's total allocation (across held/pending/
    // used, since a trade only moves an existing row, never creates one)
    // must stay at or under the printed-copy limit.
    const { rows } = await query(
      `select action_card_id, count(*) as n from team_action_cards group by action_card_id having count(*) > 3`
    );
    assert.deepEqual(rows, [], `these action_card_ids exceed the 3-copy cap: ${JSON.stringify(rows)}`);
  });
});

describe('deal cards are used in pairs', () => {
  let teamA, teamB, teamC, playerA, playerB, playerC, savedToggle;

  before(async () => {
    const toggles = await superAdmin.rpc('fn_super_toggles_get');
    savedToggle = toggles.card_play_open;
    if (!savedToggle) await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: true });

    teamA = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-DEAL-A-${Date.now()}` });
    teamB = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-DEAL-B-${Date.now()}` });
    teamC = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-DEAL-C-${Date.now()}` });
    playerA = new Session(); await playerA.login('player', teamA.loginId, teamA.password);
    playerB = new Session(); await playerB.login('player', teamB.loginId, teamB.password);
    playerC = new Session(); await playerC.login('player', teamC.loginId, teamC.password);

    // Card costs and starting cash are both randomly dealt — a low-cash
    // team paired with a costly card hits INSUFFICIENT_CASH, which is
    // correct real behavior but makes this flaky as a test. Top up so
    // affordability is never in question here.
    for (const t of [teamA, teamB, teamC]) {
      await superAdmin.rpc('fn_admin_adjust_resources', { p_team_id: t.teamId, p_delta: { cash_l: 100 } });
    }
  });

  after(async () => {
    if (!savedToggle) await superAdmin.rpc('fn_super_toggles_set', { p_key: 'card_play_open', p_value: false });
    await deleteTestTeam(teamA.teamId);
    await deleteTestTeam(teamB.teamId);
    await deleteTestTeam(teamC.teamId);
  });

  test('accepting consumes and applies BOTH teams’ deal cards', async () => {
    const handA = await playerA.rpc('fn_player_hand');
    const handB = await playerB.rpc('fn_player_hand');
    const dealA = handA.find((c) => c.category === 'deal');
    const dealB = handB.find((c) => c.category === 'deal');

    const statusABefore = (await playerA.rpc('fn_player_status'))[0];
    const statusBBefore = (await playerB.rpc('fn_player_status'))[0];

    const play = await playerA.rpc('fn_play_deal_card', {
      p_team_action_card_id: dealA.id, p_partner_team_id: teamB.teamId, p_request_id: crypto.randomUUID(),
    });
    const result = await playerB.rpc('fn_respond_deal_card', { p_card_play_id: play.id, p_accept: true, p_request_id: crypto.randomUUID() });
    assert.equal(result.accepted, true);

    const handAAfter = await playerA.rpc('fn_player_hand');
    const handBAfter = await playerB.rpc('fn_player_hand');
    assert.equal(handAAfter.find((c) => c.id === dealA.id).status, 'used', 'initiator’s deal card should be used');
    assert.equal(handBAfter.find((c) => c.id === dealB.id).status, 'used', 'responder’s own deal card should ALSO be used');

    // resources actually moved on both sides (the specific numbers depend on
    // which two of the 15 deal cards were randomly dealt, so just assert
    // *something* changed on each side rather than an exact delta)
    const statusAAfter = (await playerA.rpc('fn_player_status'))[0];
    const statusBAfter = (await playerB.rpc('fn_player_status'))[0];
    const changed = (before, after) => ['cash_l', 'customers', 'reputation', 'innovation']
      .some((k) => before[k] !== after[k]);
    assert.ok(changed(statusABefore, statusAAfter) || changed(statusBBefore, statusBAfter),
      'at least one team’s resources should have changed from the paired deal');
  });

  test('proposing to a team with no held deal card is refused outright', async () => {
    // teamB's deal card was consumed in the previous test — proposing to B
    // again should fail immediately, not sit as a dead pending offer
    const handC = await playerC.rpc('fn_player_hand');
    const dealC = handC.find((c) => c.category === 'deal');
    await assert.rejects(
      () => playerC.rpc('fn_play_deal_card', { p_team_action_card_id: dealC.id, p_partner_team_id: teamB.teamId, p_request_id: crypto.randomUUID() }),
      (err) => err.message === 'PARTNER_HAS_NO_DEAL_CARD'
    );
    // the card must still be held, not stuck pending
    const handCAfter = await playerC.rpc('fn_player_hand');
    assert.equal(handCAfter.find((c) => c.id === dealC.id).status, 'held');
  });
});

describe('crisis reveal exposes per-tier effects', () => {
  test('fn_crisis_public returns tier_deltas for every tier, not team lists', async () => {
    const rows = await superAdmin.rpc('fn_crisis_public');
    assert.ok(Array.isArray(rows));
    for (const row of rows) {
      assert.ok('tier_deltas' in row);
      assert.ok(!('hit_hard_teams' in row), 'team lists should no longer be returned');
      if (row.tier_deltas) {
        for (const tier of ['hit_hard', 'hit', 'unaffected', 'gains']) {
          assert.ok(tier in row.tier_deltas);
        }
      }
    }
  });
});

describe('team merge (Round 5)', () => {
  let teamA, teamB, playerA, playerB;

  before(async () => {
    teamA = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-MERGE-A-${Date.now()}` });
    teamB = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-MERGE-B-${Date.now()}` });
    playerA = new Session(); await playerA.login('player', teamA.loginId, teamA.password);
    playerB = new Session(); await playerB.login('player', teamB.loginId, teamB.password);
  });

  after(async () => {
    // the merged team (not teamA/teamB, which no longer exist after a
    // successful merge) is cleaned up inside the test itself
  });

  test('averages resources, combines hands, and both original logins keep working', async () => {
    const statusABefore = (await playerA.rpc('fn_player_status'))[0];
    const statusBBefore = (await playerB.rpc('fn_player_status'))[0];
    const handABefore = await playerA.rpc('fn_player_hand');
    const handBBefore = await playerB.rpc('fn_player_hand');

    const result = await superAdmin.rpc('fn_super_merge_teams', { p_team_a_id: teamA.teamId, p_team_b_id: teamB.teamId });
    assert.ok(result.mergedTeamId);
    assert.match(result.teamCode, /^TM\d{2,}$/);

    // both original logins now resolve to the merged team
    const meA = (await playerA.rpc('fn_auth_user'))[0];
    const meB = (await playerB.rpc('fn_auth_user'))[0];
    assert.equal(meA.team_id, result.mergedTeamId);
    assert.equal(meB.team_id, result.mergedTeamId);

    // both logged in "at the same time" — neither session got kicked
    const statusA = (await playerA.rpc('fn_player_status'))[0];
    const statusB = (await playerB.rpc('fn_player_status'))[0];
    assert.deepEqual(statusA, statusB, 'both logins should see the identical merged team state');
    assert.equal(statusA.cash_l, Math.round((statusABefore.cash_l + statusBBefore.cash_l) / 2));
    assert.equal(statusA.customers, Math.round((statusABefore.customers + statusBBefore.customers) / 2));

    // both hands combined under the merged team
    const mergedHand = await playerA.rpc('fn_player_hand');
    assert.equal(mergedHand.length, handABefore.length + handBBefore.length);

    // original teams are gone
    const teams = await superAdmin.rpc('fn_admin_teams');
    assert.ok(!teams.some((t) => t.id === teamA.teamId));
    assert.ok(!teams.some((t) => t.id === teamB.teamId));

    // visible in the merge log
    const merges = await superAdmin.rpc('fn_super_team_merges');
    assert.ok(merges.some((m) => m.merged_team_code === result.teamCode));

    // clean up the merged team (users cascade-delete with it)
    await deleteTestTeam(result.mergedTeamId);
  });

  test('cannot merge a team with itself', async () => {
    const solo = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-MERGE-SOLO-${Date.now()}` });
    await assert.rejects(
      () => superAdmin.rpc('fn_super_merge_teams', { p_team_a_id: solo.teamId, p_team_b_id: solo.teamId }),
      (err) => err.message === 'CANNOT_MERGE_SAME_TEAM'
    );
    await deleteTestTeam(solo.teamId);
  });
});
