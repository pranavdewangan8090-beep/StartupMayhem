import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { actionLimiter } from '../middleware/rateLimit.js';
import { h } from '../lib/errors.js';

const router = Router();
router.use(requireAuth, requireRole('player'));

// Full catalog (45 cards, 15 per category), for the R2 selection portal.
router.get(
  '/catalog',
  h(async (req, res) => {
    const { rows } = await pool.query(
      'select id, category, name, description, effect_text from action_cards where is_active order by category, name'
    );
    res.json(rows);
  })
);

const requestSchema = z.object({ actionCardId: z.number().int().positive(), requestId: z.string().uuid() });

router.post(
  '/request',
  actionLimiter,
  validate(requestSchema),
  h(async (req, res) => {
    const { rows } = await pool.query('select * from fn_r2_request_card($1, $2, $3)', [
      req.user.teamId, req.body.actionCardId, req.body.requestId,
    ]);
    res.json(rows[0]);
  })
);

// The team's own 3 (max, one per category) action cards, with status
// (held/pending/used) so the UI can grey out anything not currently usable.
router.get(
  '/hand',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select tac.id, tac.status, tac.source, tac.acquired_at,
              ac.id as action_card_id, ac.category, ac.name, ac.description, ac.effect_text
       from team_action_cards tac join action_cards ac on ac.id = tac.action_card_id
       where tac.team_id = $1
       order by tac.acquired_at`,
      [req.user.teamId]
    );
    res.json(rows);
  })
);

// Deal partners need a simple team list (id + code only — never resources
// or decision points here).
router.get(
  '/teams',
  h(async (req, res) => {
    const { rows } = await pool.query('select id, team_code from teams where is_active and id <> $1 order by team_code', [
      req.user.teamId,
    ]);
    res.json(rows);
  })
);

const playSelfSchema = z.object({ teamActionCardId: z.string().uuid(), requestId: z.string().uuid() });
router.post(
  '/play/self',
  actionLimiter,
  validate(playSelfSchema),
  h(async (req, res) => {
    const { rows } = await pool.query('select fn_play_self_card($1, $2, $3) as result', [
      req.user.teamId, req.body.teamActionCardId, req.body.requestId,
    ]);
    res.json(rows[0].result);
  })
);

const playDealSchema = z.object({
  teamActionCardId: z.string().uuid(),
  partnerTeamId: z.number().int().positive(),
  requestId: z.string().uuid(),
});
router.post(
  '/play/deal',
  actionLimiter,
  validate(playDealSchema),
  h(async (req, res) => {
    const { rows } = await pool.query('select * from fn_play_deal_card($1, $2, $3, $4)', [
      req.user.teamId, req.body.teamActionCardId, req.body.partnerTeamId, req.body.requestId,
    ]);
    res.json(rows[0]);
  })
);

// Deal offers made TO this team (pending response)
router.get(
  '/deals/incoming',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select cp.id, cp.created_at, ac.name, ac.description, ac.effect_text,
              t.team_code as from_team_code
       from card_plays cp
       join action_cards ac on ac.id = cp.action_card_id
       join teams t on t.id = cp.team_id
       where cp.other_team_id = $1 and cp.status = 'pending'
       order by cp.created_at`,
      [req.user.teamId]
    );
    res.json(rows);
  })
);

// cardPlayId is a bigserial primary key — pg returns bigint columns as
// strings, so this must coerce rather than require an already-numeric value.
const respondDealSchema = z.object({ cardPlayId: z.coerce.number().int().positive(), accept: z.boolean(), requestId: z.string().uuid() });
router.post(
  '/deals/respond',
  actionLimiter,
  validate(respondDealSchema),
  h(async (req, res) => {
    const { rows } = await pool.query('select fn_respond_deal_card($1, $2, $3, $4) as result', [
      req.user.teamId, req.body.cardPlayId, req.body.accept, req.body.requestId,
    ]);
    res.json(rows[0].result);
  })
);

export default router;
