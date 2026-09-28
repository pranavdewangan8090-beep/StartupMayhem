import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, withTransaction } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { actionLimiter } from '../middleware/rateLimit.js';
import { h } from '../lib/errors.js';

const router = Router();
router.use(requireAuth, requireRole('super_admin'));

function randomPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomFillSync(new Uint8Array(8))).map((b) => alphabet[b % alphabet.length]).join('');
}

// ---------------------------------------------------------------------------
// Toggles
// ---------------------------------------------------------------------------
const toggleSchema = z.object({
  key: z.enum(['r1_replace_open', 'r2_selection_open', 'card_play_open']),
  value: z.boolean(),
});
router.post(
  '/toggles',
  actionLimiter,
  validate(toggleSchema),
  h(async (req, res) => {
    const { key, value } = req.body;
    await pool.query(`update game_state set ${key} = $1, updated_at = now() where id = 1`, [value]);
    res.json({ ok: true });
  })
);

router.get(
  '/toggles',
  h(async (req, res) => {
    const { rows } = await pool.query('select * from game_state where id = 1');
    res.json(rows[0]);
  })
);

// ---------------------------------------------------------------------------
// Team management
// ---------------------------------------------------------------------------
const addTeamSchema = z.object({ teamCode: z.string().min(1).max(20) });
router.post(
  '/teams',
  actionLimiter,
  validate(addTeamSchema),
  h(async (req, res) => {
    const result = await withTransaction(async (client) => {
      const pick = async (category) => {
        const { rows } = await client.query(
          'select id, start_cash_l, start_customers, start_reputation, start_innovation from identity_cards where category=$1 order by random() limit 1',
          [category]
        );
        return rows[0];
      };
      const market = await pick('market');
      const customer = await pick('customer');
      const mission = await pick('mission');
      const resources = await pick('resources');

      const { rows: teamRows } = await client.query(
        `insert into teams (team_code, cash_l, customers, reputation, innovation,
           market_card_id, customer_card_id, mission_card_id, resources_card_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [req.body.teamCode, resources.start_cash_l, resources.start_customers, resources.start_reputation,
         resources.start_innovation, market.id, customer.id, mission.id, resources.id]
      );
      const teamId = teamRows[0].id;

      const password = randomPassword();
      const hash = await bcrypt.hash(password, 10);
      await client.query('insert into users (role, login_id, password_hash, team_id) values (\'player\',$1,$2,$3)', [
        req.body.teamCode, hash, teamId,
      ]);
      return { teamId, password };
    });

    res.json({ teamId: result.teamId, teamCode: req.body.teamCode, password: result.password });
  })
);

router.post(
  '/teams/:teamId/deactivate',
  actionLimiter,
  h(async (req, res) => {
    const teamId = parseInt(req.params.teamId, 10);
    await pool.query('update teams set is_active = false where id = $1', [teamId]);
    await pool.query('update users set is_active = false where team_id = $1', [teamId]);
    res.json({ ok: true });
  })
);

router.post(
  '/users/:userId/reset-password',
  actionLimiter,
  h(async (req, res) => {
    const password = randomPassword();
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'update users set password_hash = $1, session_version = session_version + 1 where id = $2 returning login_id, role',
      [hash, req.params.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User not found.' });
    res.json({ loginId: rows[0].login_id, role: rows[0].role, password });
  })
);

// ---------------------------------------------------------------------------
// Decision points (visible ONLY to super admin, per the rules) + leaderboard
// ---------------------------------------------------------------------------
router.get(
  '/decision-points',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select id as team_id, team_code, decision_points from teams order by team_code`
    );
    res.json(rows);
  })
);

// Resource Score (30%) + Decision Score (70%) + Secret Mission bonus, per the
// Point System doc. Rounds 4-6 marks are entered here too (as decision point
// deltas) — this app does not run those rounds itself.
router.get(
  '/leaderboard',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select t.id as team_id, t.team_code, t.cash_l, t.customers, t.reputation, t.innovation,
              t.mission_completed, t.decision_points,
              mc.bonus_points
       from teams t
       left join identity_cards mc on mc.id = t.mission_card_id
       where t.is_active
       order by t.team_code`
    );
    const scored = rows.map((r) => {
      const x = Math.min(r.cash_l / 10, 10); // ₹ millions, capped at 10
      const y = Math.min(r.customers / 20000, 10);
      const cashScore = (x / 10) * 100;
      const customerScore = (y / 10) * 100;
      const reputationScore = (r.reputation / 5) * 100;
      const innovationScore = (r.innovation / 10) * 100;
      const resourceScore = 0.3 * cashScore + 0.3 * customerScore + 0.2 * reputationScore + 0.2 * innovationScore;
      const decisionScore = Math.max(0, Math.min(100, Number(r.decision_points)));
      const missionBonus = r.mission_completed ? Number(r.bonus_points || 0) : 0;
      const total = 0.3 * resourceScore + 0.7 * decisionScore + missionBonus;
      return {
        teamId: r.team_id,
        teamCode: r.team_code,
        resourceScore: Math.round(resourceScore * 10) / 10,
        decisionScore: Math.round(decisionScore * 10) / 10,
        missionBonus,
        totalScore: Math.round(total * 10) / 10,
      };
    });
    scored.sort((a, b) => b.totalScore - a.totalScore);
    res.json(scored);
  })
);

const missionSchema = z.object({ teamId: z.number().int().positive(), completed: z.boolean() });
router.post(
  '/mission/mark',
  actionLimiter,
  validate(missionSchema),
  h(async (req, res) => {
    await pool.query('update teams set mission_completed = $1 where id = $2', [req.body.completed, req.body.teamId]);
    res.json({ ok: true });
  })
);

export default router;
