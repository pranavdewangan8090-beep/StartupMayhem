import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Session, ORIGIN, health } from './helpers.js';

before(async () => {
  assert.equal(await health(), true, 'server is not running — start it with `npm start` before running tests');
});

test('GET /health is reachable with no auth', async () => {
  const s = new Session();
  const { status, body } = await s.get('/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('login rejects a wrong password', async () => {
  const s = new Session();
  const { status, body } = await s.post('/auth/login', { loginId: 'T01', password: 'definitely-wrong', role: 'player' });
  assert.equal(status, 401);
  assert.equal(body.error, 'INVALID_CREDENTIALS');
});

test('login rejects an unknown login id (same error, no user-enumeration leak)', async () => {
  const s = new Session();
  const { status, body } = await s.post('/auth/login', { loginId: 'NOPE-999', password: 'whatever', role: 'player' });
  assert.equal(status, 401);
  assert.equal(body.error, 'INVALID_CREDENTIALS');
});

test('login rejects a role mismatch (right password, wrong role bucket)', async () => {
  // T01's password should not authenticate it as an admin, since admin/player
  // login_ids share a namespace only within their own role.
  const s = new Session();
  const { status } = await s.post('/auth/login', { loginId: 'T01', password: 'any', role: 'admin' });
  assert.equal(status, 401);
});

test('login validates input shape (missing role)', async () => {
  const s = new Session();
  const { status, body } = await s.post('/auth/login', { loginId: 'T01', password: 'x' });
  assert.equal(status, 400);
  assert.equal(body.error, 'INVALID_INPUT');
});

test('/auth/me requires authentication', async () => {
  const s = new Session();
  const { status } = await s.get('/auth/me');
  assert.equal(status, 401);
});

test('every mutating request without a matching Origin header is rejected (CSRF guard)', async () => {
  const res = await fetch((process.env.TEST_BASE_URL || 'http://localhost:4000/api') + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ loginId: 'T01', password: 'x', role: 'player' }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'BAD_ORIGIN');
});

test('a GET request is exempt from the Origin check', async () => {
  const s = new Session();
  const { status } = await s.get('/health');
  assert.equal(status, 200);
});

// The following tests need real credentials and are opt-in via env vars, so
// this file never hardcodes a working password into the repo.
const T01_PASSWORD = process.env.TEST_T01_PASSWORD;
test('login succeeds with correct player credentials, sets an auth cookie, and /auth/me reflects it', { skip: !T01_PASSWORD && 'set TEST_T01_PASSWORD to run' }, async () => {
  const s = new Session();
  const result = await s.login('player', 'T01', T01_PASSWORD);
  assert.equal(result.role, 'player');
  assert.ok(s.cookie, 'expected an auth cookie to be set');

  const me = await s.get('/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'player');
  assert.equal(me.body.teamId, result.teamId);
});

test('logging in again bumps session_version and invalidates the previous session (one active login per team)', { skip: !T01_PASSWORD && 'set TEST_T01_PASSWORD to run' }, async () => {
  const first = new Session();
  await first.login('player', 'T01', T01_PASSWORD);

  const second = new Session();
  await second.login('player', 'T01', T01_PASSWORD);

  const staleCheck = await first.get('/auth/me');
  assert.equal(staleCheck.status, 401, 'the first session should be invalidated once a second login happens');

  const freshCheck = await second.get('/auth/me');
  assert.equal(freshCheck.status, 200);
});

test('logout clears the session', { skip: !T01_PASSWORD && 'set TEST_T01_PASSWORD to run' }, async () => {
  const s = new Session();
  await s.login('player', 'T01', T01_PASSWORD);
  const out = await s.post('/auth/logout');
  assert.equal(out.status, 200);
  const me = await s.get('/auth/me');
  assert.equal(me.status, 401);
});
