// Shared credential/session fixtures. Nothing here hardcodes a real
// password — every credential comes from an environment variable so this
// file is safe to commit. Tests that need a role they weren't given
// credentials for skip themselves with a clear message instead of failing.
//
// node --test runs every *.test.js file as its own process, so an
// in-memory cache here only helps within one file. Login also bumps
// session_version and invalidates any older session for the same login ID
// (by design — one active session per account), and the login route is
// itself rate-limited. Re-logging in once per file would (a) burn through
// that rate limit across a full suite run and (b) invalidate a sibling
// file's still-in-use session. So the session is cached on disk, shared by
// every file in this run, and reused if it still checks out live.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from './helpers.js';

const CACHE_DIR = path.join(os.tmpdir(), 'startup-mayhem-test-sessions');

function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.cookie`);
}

async function cachedLogin(key, role, loginId, password) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = cachePath(key);

  if (fs.existsSync(file)) {
    const s = new Session();
    s.cookie = fs.readFileSync(file, 'utf8').trim();
    const { status } = await s.get('/auth/me');
    if (status === 200) return s;
    // stale (another file logged in again since, or it expired) — fall through and re-login
  }

  const s = new Session();
  await s.login(role, loginId, password);
  fs.writeFileSync(file, s.cookie);
  return s;
}

export const CREDS = {
  superAdminId: process.env.TEST_SUPER_ADMIN_ID,
  superAdminPassword: process.env.TEST_SUPER_ADMIN_PASSWORD,
  adminId: process.env.TEST_ADMIN_ID,
  adminPassword: process.env.TEST_ADMIN_PASSWORD,
  playerTeamCode: process.env.TEST_PLAYER_TEAM_CODE || 'T01',
  playerPassword: process.env.TEST_T01_PASSWORD,
};

export async function getSuperAdmin() {
  if (!CREDS.superAdminId || !CREDS.superAdminPassword) return null;
  return cachedLogin('super_admin', 'super_admin', CREDS.superAdminId, CREDS.superAdminPassword);
}

export async function getAdmin() {
  if (!CREDS.adminId || !CREDS.adminPassword) return null;
  return cachedLogin('admin', 'admin', CREDS.adminId, CREDS.adminPassword);
}

export const SKIP_NO_SUPER_ADMIN = 'set TEST_SUPER_ADMIN_ID and TEST_SUPER_ADMIN_PASSWORD to run';
export const SKIP_NO_ADMIN = 'set TEST_ADMIN_ID and TEST_ADMIN_PASSWORD to run';
export const SKIP_NO_PLAYER = 'set TEST_T01_PASSWORD to run';

/**
 * Runs `fn` with the given game_state toggles forced to specific values,
 * then restores whatever they were before — so a test run never permanently
 * opens/closes a phase of the real game for real teams.
 */
export async function withToggles(superAdminSession, overrides, fn) {
  const { body: original } = await superAdminSession.get('/super-admin/toggles');
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (original[key] !== value) {
        await superAdminSession.post('/super-admin/toggles', { key, value });
      }
    }
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (original[key] !== overrides[key]) {
        await superAdminSession.post('/super-admin/toggles', { key, value: original[key] });
      }
    }
  }
}
