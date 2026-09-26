// Minimal HTTP + cookie-jar client for integration-testing the real running
// server (node --test doesn't spin up its own server here — start the app
// yourself first with `npm start`, then run `npm test`).
//
// Safety model: these tests run against whatever database the server is
// pointed at. To avoid disturbing real teams' state during a live event,
// every test that needs to mutate game data creates its own disposable
// "TEST-xxxx" team via the Super Admin API and deactivates it afterward,
// instead of touching one of the real seeded teams. Toggle flips are
// captured and restored. See README at the bottom of this file for the
// two genuinely destructive tests that are opt-in only.

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4000/api';
export const ORIGIN = process.env.TEST_ORIGIN || 'http://localhost:5173';

function parseCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  return setCookieHeader.split(';')[0];
}

/** One authenticated (or anonymous) session with its own cookie jar. */
export class Session {
  constructor() {
    this.cookie = null;
  }

  async raw(path, { method = 'GET', body } = {}) {
    const headers = { Origin: ORIGIN };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;

    const res = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = parseCookie(setCookie);

    let json = null;
    try { json = await res.json(); } catch { /* no body (e.g. 204) */ }
    return { status: res.status, body: json };
  }

  get(path) { return this.raw(path); }
  post(path, body = {}) { return this.raw(path, { method: 'POST', body }); }

  async login(role, loginId, password) {
    const { status, body } = await this.post('/auth/login', { loginId, password, role });
    if (status !== 200) throw new Error(`login failed for ${role}/${loginId}: ${status} ${JSON.stringify(body)}`);
    return body;
  }
}

export function requestId() {
  return crypto.randomUUID();
}

export async function health() {
  const res = await fetch(BASE_URL + '/health');
  return res.status === 200;
}

/**
 * Creates a disposable team via the Super Admin API for tests that need to
 * mutate team state (replace cards, request action cards, adjust resources,
 * record a mayhem response) without touching a real seeded team.
 * Returns { teamId, teamCode, playerSession } — the team starts deactivated
 * at the end of the test via `cleanupTeam`.
 */
export async function createTestTeam(superAdminSession) {
  const teamCode = `ZTEST${Math.floor(Math.random() * 100000)}`;
  const { status, body } = await superAdminSession.post('/super-admin/teams', { teamCode });
  if (status !== 200) throw new Error(`could not create test team: ${status} ${JSON.stringify(body)}`);

  const playerSession = new Session();
  await playerSession.login('player', body.teamCode, body.password);

  const { body: teams } = await superAdminSession.get('/admin/teams');
  const team = teams.find((t) => t.team_code === body.teamCode);

  return { teamId: team.id, teamCode: body.teamCode, password: body.password, playerSession };
}

export async function cleanupTeam(superAdminSession, teamId) {
  await superAdminSession.post(`/super-admin/teams/${teamId}/deactivate`, {});
}
