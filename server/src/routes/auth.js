import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { signToken } from '../lib/jwt.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, AUTH_COOKIE_NAME } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { h } from '../lib/errors.js';

const router = Router();

// Admin IDs (1-30) and Super Admin IDs (1-5) are plain numbers and can collide
// with each other (and, in principle, with a team code) unless the role is
// also given. The login screen shows one Team/Admin/Super Admin selector
// alongside the ID and password fields, so it is still a single screen.
const loginSchema = z.object({
  loginId: z.string().min(1).max(50),
  password: z.string().min(1).max(200),
  role: z.enum(['player', 'admin', 'super_admin']),
});

// A precomputed bcrypt hash of a random value, with no matching password.
// Used to give a nonexistent login ID the same bcrypt.compare() cost as a
// real one, above.
const DUMMY_HASH = '$2a$10$C6UzMDM.H6dfI/f/IKcEeO0uJHZUjZ8yQaVh5xB.z3zH0m1oQ7YKO';

const isProd = process.env.NODE_ENV === 'production';
const cookieOpts = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
  maxAge: 12 * 60 * 60 * 1000,
  path: '/',
};

// Login is shared by players, admins and super admins. Role is derived from
// the DB row, never trusted from the client. A player login bumps
// session_version, which immediately logs out any other phone already signed
// in as that team (one active session per team).
router.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  h(async (req, res) => {
    const { loginId, password, role } = req.body;

    const { rows } = await pool.query(
      `select id, role, team_id, password_hash, is_active, session_version
       from users where login_id = $1 and role = $2`,
      [loginId, role]
    );
    const user = rows[0];
    // Always run a bcrypt compare, even for a login ID that doesn't exist, so
    // the response time doesn't reveal which IDs are valid (a login ID is
    // not secret here, but this costs nothing and removes the leak).
    const hashToCheck = user?.password_hash || DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, hashToCheck);
    const ok = user && user.is_active && passwordMatches;
    if (!ok) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Wrong ID or password.' });
    }

    const { rows: bumped } = await pool.query(
      'update users set session_version = session_version + 1, last_login_at = now() where id = $1 returning session_version',
      [user.id]
    );
    const sessionVersion = bumped[0].session_version;

    const token = signToken({ sub: user.id, role: user.role, sv: sessionVersion });
    res.cookie(AUTH_COOKIE_NAME, token, cookieOpts);
    res.json({ role: user.role, teamId: user.team_id });
  })
);

router.post('/logout', requireAuth, (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, { ...cookieOpts, maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ role: req.user.role, teamId: req.user.teamId });
});

export default router;
