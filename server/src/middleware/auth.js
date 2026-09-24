import { verifyToken } from '../lib/jwt.js';
import { pool } from '../db/pool.js';

const COOKIE_NAME = 'sm_token';

/**
 * Verifies the JWT AND re-checks session_version against the DB on every
 * request. This is what makes "one active login per team" actually work: a
 * fresh login bumps session_version, which immediately invalidates every
 * token issued before it, even ones an old phone still has cached.
 */
export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'NOT_AUTHENTICATED', message: 'Please log in.' });

    const payload = verifyToken(token);
    const { rows } = await pool.query(
      'select id, role, team_id, is_active, session_version from users where id = $1',
      [payload.sub]
    );
    const user = rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'NOT_AUTHENTICATED', message: 'Please log in.' });
    }
    if (user.session_version !== payload.sv) {
      return res.status(401).json({ error: 'SESSION_REPLACED', message: 'You were logged out because this team logged in elsewhere.' });
    }

    req.user = { id: user.id, role: user.role, teamId: user.team_id };
    next();
  } catch {
    return res.status(401).json({ error: 'NOT_AUTHENTICATED', message: 'Please log in.' });
  }
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
