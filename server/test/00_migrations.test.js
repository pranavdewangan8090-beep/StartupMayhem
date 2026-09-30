// Runs first (numeric prefix sorts before the alphabetic test files) and
// checks that 025/026 have actually been applied to the DATABASE_URL
// project — as opposed to just existing as files in sql/. Without this, a
// stale database produces a confusing wall of unrelated-looking failures
// across every other test file (missing functions, a leftover unique
// constraint, a "should be rejected" test that isn't) instead of one clear
// "you forgot to run the migration" message.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './helpers.js';

describe('pre-flight: 025/026 are applied to this DATABASE_URL/SUPABASE_URL project', () => {
  test('025_security_lockdown.sql: fn_current_jwt_secret is not callable over the API', async () => {
    const anon = new Session();
    await assert.rejects(
      () => anon.rpc('fn_current_jwt_secret'),
      (err) => err.status === 404 || err.status === 401 || err.status === 403,
      'fn_current_jwt_secret is still callable without logging in — apply server/sql/025_security_lockdown.sql ' +
        '(direct Postgres access may be blocked from this network; use the Supabase SQL Editor instead).'
    );
  });

  test('026_event_safety_fixes.sql: fn_super_accounts exists', async () => {
    const anon = new Session();
    const err = await anon.rpc('fn_super_accounts').catch((e) => e);
    assert.ok(
      err instanceof Error && err.status !== 404,
      'fn_super_accounts was not found — apply server/sql/026_event_safety_fixes.sql ' +
        '(direct Postgres access may be blocked from this network; use the Supabase SQL Editor instead).'
    );
  });
});
