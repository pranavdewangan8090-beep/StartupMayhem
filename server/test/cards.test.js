import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Session, loadCredentials, pick } from './helpers.js';
import { deleteTestTeam, closePool } from './db.js';

const creds = loadCredentials();
let superAdmin, team, player, toggleWasOpen;

before(async () => {
  superAdmin = new Session();
  const sa = pick(creds, 'super_admin');
  await superAdmin.login('super_admin', sa.loginId, sa.password);

  const toggles = await superAdmin.rpc('fn_super_toggles_get');
  toggleWasOpen = toggles.r1_replace_open;
  if (!toggleWasOpen) await superAdmin.rpc('fn_super_toggles_set', { p_key: 'r1_replace_open', p_value: true });

  team = await superAdmin.rpc('fn_super_add_team', { p_team_code: `TEST-CARDS-${Date.now()}` });
  player = new Session();
  await player.login('player', team.teamCode, team.password);
});

after(async () => {
  if (!toggleWasOpen) await superAdmin.rpc('fn_super_toggles_set', { p_key: 'r1_replace_open', p_value: false });
  await deleteTestTeam(team.teamId);
  await closePool();
});

describe('player identity cards (fn_player_cards / fn_replace_identity_card)', () => {
  test('fn_player_cards returns exactly this team\'s 4 cards, 0 replacements used', async () => {
    const rows = await player.rpc('fn_player_cards');
    const row = rows[0];
    assert.equal(row.replacements_used, 0);
    for (const cat of ['market', 'customer', 'mission', 'resources']) {
      assert.ok(row[`${cat}_id`], `${cat}_id should be set`);
      assert.ok(row[`${cat}_title`], `${cat}_title should be set`);
    }
  });

  test('a disposable team cannot read another team\'s cards', async () => {
    const rows = await player.rpc('fn_player_cards');
    assert.equal(rows.length, 1); // fn_auth_user() scopes this to exactly the caller's own team
  });

  test('replace swaps the card and increments replacements_used', async () => {
    const before = (await player.rpc('fn_player_cards'))[0];
    const replaced = await player.rpc('fn_replace_identity_card', { p_category: 'market' });
    assert.notEqual(replaced.id, before.market_id);
    assert.equal(replaced.category, 'market');

    const after = (await player.rpc('fn_player_cards'))[0];
    assert.equal(after.market_id, replaced.id);
    assert.equal(after.replacements_used, 1);
  });

  test('the 3-replacement cap is enforced', async () => {
    await player.rpc('fn_replace_identity_card', { p_category: 'customer' });
    await player.rpc('fn_replace_identity_card', { p_category: 'mission' });
    // that's 3 total including the 'market' replace above
    await assert.rejects(
      () => player.rpc('fn_replace_identity_card', { p_category: 'resources' }),
      (err) => err.message === 'REPLACEMENT_LIMIT_REACHED'
    );
  });

  test('an unknown category is rejected', async () => {
    const s2 = new Session();
    const sa = pick(creds, 'super_admin');
    await s2.login('super_admin', sa.loginId, sa.password);
    const team2 = await s2.rpc('fn_super_add_team', { p_team_code: `TEST-CARDS2-${Date.now()}` });
    const p2 = new Session();
    await p2.login('player', team2.teamCode, team2.password);
    await assert.rejects(
      () => p2.rpc('fn_replace_identity_card', { p_category: 'not-a-real-category' }),
      (err) => err.message === 'BAD_CATEGORY'
    );
    await deleteTestTeam(team2.teamId);
  });

  test('a non-player (e.g. anon) cannot call fn_replace_identity_card', async () => {
    const anon = new Session();
    await assert.rejects(
      () => anon.rpc('fn_replace_identity_card', { p_category: 'market' }),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });
});
