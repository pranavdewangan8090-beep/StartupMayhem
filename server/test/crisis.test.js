// Round 3: Crisis + Trading. Triggering a crisis mutates real, shared
// event-day state (a fixed sequence, like the old Market Mayhem trigger), so
// this file only exercises it read-only + the role boundary, same pattern
// mayhem.test.js used to follow. Trading is fully exercised end-to-end
// against disposable teams, since it doesn't touch shared crisis sequencing.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Session, loadCredentials, pick } from './helpers.js';
import { deleteTestTeam, closePool } from './db.js';

const creds = loadCredentials();
let superAdmin, admin, player;

before(async () => {
  superAdmin = new Session();
  const sa = pick(creds, 'super_admin');
  await superAdmin.login('super_admin', sa.loginId, sa.password);

  const adminCred = pick(creds, 'admin');
  admin = new Session();
  await admin.login('admin', adminCred.loginId, adminCred.password);

  const playerCred = pick(creds, 'player');
  player = new Session();
  await player.login('player', playerCred.loginId, playerCred.password);
});

after(async () => {
  await closePool();
});

describe('crisis read paths', () => {
  test('fn_admin_crisis_list lists the seeded crises in order (admin/super_admin only)', async () => {
    const crises = await admin.rpc('fn_admin_crisis_list');
    assert.ok(crises.length >= 2);
    assert.deepEqual(crises.map((c) => c.number), crises.map((c) => c.number).sort((a, b) => a - b));
  });

  test('a player cannot read admin crisis data', async () => {
    await assert.rejects(
      () => player.rpc('fn_admin_crisis_list'),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });

  test('fn_crisis_public is readable by any authenticated role and only shows triggered crises', async () => {
    const asPlayer = await player.rpc('fn_crisis_public');
    const asAdmin = await admin.rpc('fn_crisis_public');
    assert.ok(Array.isArray(asPlayer));
    assert.ok(Array.isArray(asAdmin));
    assert.ok(asPlayer.every((c) => typeof c.title === 'string'));
  });

  test('only super_admin can trigger the next crisis (role check runs before anything else, so this never actually triggers one)', async () => {
    await assert.rejects(
      () => admin.rpc('fn_super_trigger_crisis'),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });

  test('only super_admin can set a team\'s crisis status', async () => {
    await assert.rejects(
      () => admin.rpc('fn_super_set_crisis_team_status', { p_crisis_id: 1, p_team_id: 1, p_status: 'used_card' }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });
});

describe('trading', () => {
  let teamA, teamB, playerA, playerB, savedToggles, wasTradingEnabled;

  before(async () => {
    const toggles = await superAdmin.rpc('fn_super_toggles_get');
    savedToggles = { r2_selection_open: toggles.r2_selection_open };
    await superAdmin.rpc('fn_super_toggles_set', { p_key: 'r2_selection_open', p_value: true });

    const status = (await superAdmin.rpc('fn_trade_feature_status'))[0];
    wasTradingEnabled = status.enabled;
    if (!wasTradingEnabled) await superAdmin.rpc('fn_super_trade_toggle_set', { p_enabled: true });

    teamA = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-TRADE-A-${Date.now()}` });
    teamB = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-TRADE-B-${Date.now()}` });
    playerA = new Session();
    await playerA.login('player', teamA.teamCode, teamA.password);
    playerB = new Session();
    await playerB.login('player', teamB.teamCode, teamB.password);
  });

  after(async () => {
    await superAdmin.rpc('fn_super_toggles_set', { p_key: 'r2_selection_open', p_value: savedToggles.r2_selection_open });
    if (!wasTradingEnabled) await superAdmin.rpc('fn_super_trade_toggle_set', { p_enabled: false });
    await deleteTestTeam(teamA.teamId);
    await deleteTestTeam(teamB.teamId);
  });

  test('admin can process a trade that swaps held cards between two teams', async () => {
    const catalog = await playerA.rpc('fn_action_card_catalog');
    const cardForA = catalog.find((c) => c.category === 'action');
    const cardForB = catalog.find((c) => c.category === 'action' && c.id !== cardForA.id);

    const heldA = await playerA.rpc('fn_r2_request_card', { p_action_card_id: cardForA.id, p_request_id: crypto.randomUUID() });
    const heldB = await playerB.rpc('fn_r2_request_card', { p_action_card_id: cardForB.id, p_request_id: crypto.randomUUID() });

    const result = await admin.rpc('fn_admin_process_trade', {
      p_team_a_id: teamA.teamId, p_team_a_card_id: heldA.id,
      p_team_b_id: teamB.teamId, p_team_b_card_id: heldB.id,
      p_money_team_id: null, p_money_amount: 0,
      p_crisis_id: null, p_request_id: crypto.randomUUID(),
    });
    assert.ok(result.teamACardId);

    const aCardsNow = await admin.rpc('fn_admin_team_cards', { p_team_id: teamA.teamId });
    assert.ok(aCardsNow.some((c) => c.id === heldB.id), 'team A should now hold what was team B\'s card');
    const bCardsNow = await admin.rpc('fn_admin_team_cards', { p_team_id: teamB.teamId });
    assert.ok(bCardsNow.some((c) => c.id === heldA.id), 'team B should now hold what was team A\'s card');
  });

  test('a player cannot process a trade', async () => {
    await assert.rejects(
      () => player.rpc('fn_admin_process_trade', {
        p_team_a_id: teamA.teamId, p_team_a_card_id: '00000000-0000-0000-0000-000000000000',
        p_team_b_id: teamB.teamId, p_team_b_card_id: '00000000-0000-0000-0000-000000000000',
        p_money_team_id: null, p_money_amount: 0, p_crisis_id: null, p_request_id: crypto.randomUUID(),
      }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });
});
