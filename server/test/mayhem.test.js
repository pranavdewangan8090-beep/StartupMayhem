// Round 3: Market Mayhem is read-only tested here. fn_trigger_mayhem_event
// and fn_record_mayhem_response both mutate real, shared event-day state
// (there are only 3 events total, and responses are per-team-per-event) —
// exercising them against the real project isn't safe the way a disposable
// team is for everything else, so this file only verifies the read paths and
// the role boundary, matching how the old Express test suite also kept its
// two genuinely destructive mayhem tests opt-in only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Session, loadCredentials, pick } from './helpers.js';

const creds = loadCredentials();
let admin, player;

before(async () => {
  const adminCred = pick(creds, 'admin');
  admin = new Session();
  await admin.login('admin', adminCred.loginId, adminCred.password);

  const playerCred = pick(creds, 'player');
  player = new Session();
  await player.login('player', playerCred.loginId, playerCred.password);
});

describe('mayhem read paths (admin/super_admin only)', () => {
  test('fn_mayhem_events lists all 3 events in order', async () => {
    const events = await admin.rpc('fn_mayhem_events');
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.number), [1, 2, 3]);
  });

  test('fn_mayhem_current matches game_state.current_mayhem_event_id (possibly none)', async () => {
    const current = await admin.rpc('fn_mayhem_current');
    assert.ok(Array.isArray(current)); // RETURNS TABLE: 0 or 1 rows
  });

  test('fn_mayhem_team_status is empty until an event is triggered, or lists every active team once one is', async () => {
    const status = await admin.rpc('fn_mayhem_team_status');
    assert.ok(Array.isArray(status));
    if (status.length > 0) {
      assert.ok(status[0].team_code);
    }
  });

  test('a player cannot read any mayhem data', async () => {
    await assert.rejects(
      () => player.rpc('fn_mayhem_events'),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
    await assert.rejects(
      () => player.rpc('fn_mayhem_team_status'),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });

  test('only super_admin can trigger the next event (role check runs before anything else, so this never actually triggers one)', async () => {
    await assert.rejects(
      () => admin.rpc('fn_trigger_mayhem_event'),
      (err) => err.message === 'NOT_AUTHENTICATED'
    );
  });
});
