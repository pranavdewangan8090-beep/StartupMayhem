import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { actionLimiter } from '../middleware/rateLimit.js';
import { h } from '../lib/errors.js';

const router = Router();
// Everything here is available to both 'admin' and 'super_admin' — the
// super-admin-only extras (team management, toggles, mayhem trigger, full
// decision-point visibility, leaderboard) live in routes/superAdmin.js.
router.use(requireAuth, requireRole('admin', 'super_admin'));

router.get(
  '/teams',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select t.id, t.team_code, t.cash_l, t.customers, t.reputation, t.innovation,
              t.replacements_used, t.mission_completed,
              mk.title as market_title, cu.title as customer_title, pr.title as problem_title
       from teams t
       join identity_cards mk on mk.id = t.market_card_id
       join identity_cards cu on cu.id = t.customer_card_id
       join identity_cards pr on pr.id = t.problem_card_id
       where t.is_active
       order by t.team_code`
    );
    res.json(rows);
  })
);

router.get(
  '/teams/:teamId/cards',
  h(async (req, res) => {
    const teamId = parseInt(req.params.teamId, 10);
    const { rows } = await pool.query(
      `select tac.id, tac.status, ac.category, ac.name, ac.description, ac.effect_text
       from team_action_cards tac join action_cards ac on ac.id = tac.action_card_id
       where tac.team_id = $1 order by tac.acquired_at`,
      [teamId]
    );
    res.json(rows);
  })
);

const adjustResourceSchema = z.object({
  teamId: z.number().int().positive(),
  dCashL: z.number().int().min(-1000).max(1000).default(0),
  dCustomers: z.number().int().min(-1_000_000).max(1_000_000).default(0),
  dReputation: z.number().int().min(-5).max(5).default(0),
  dInnovation: z.number().int().min(-10).max(10).default(0),
});
router.post(
  '/resources/adjust',
  actionLimiter,
  validate(adjustResourceSchema),
  h(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      'select fn_admin_adjust_resources($1,$2,$3,$4,$5) as result',
      [b.teamId, b.dCashL, b.dCustomers, b.dReputation, b.dInnovation]
    );
    res.json(rows[0].result);
  })
);

const adjustPointsSchema = z.object({
  teamId: z.number().int().positive(),
  delta: z.number().int().min(-30).max(30).refine((v) => v !== 0, 'delta cannot be zero'),
});
router.post(
  '/decision-points/adjust',
  actionLimiter,
  validate(adjustPointsSchema),
  h(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query('select * from fn_admin_adjust_decision_points($1,$2)', [b.teamId, b.delta]);
    res.json(rows[0]);
  })
);

export default router;
