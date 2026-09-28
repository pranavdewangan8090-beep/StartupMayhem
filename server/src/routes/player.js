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

// ---------------------------------------------------------------------------
// R1: identity cards
// ---------------------------------------------------------------------------
router.get(
  '/cards',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select
         mk.id as market_id, mk.title as market_title, mk.tagline as market_tagline, mk.description as market_desc, mk.event_tags as market_tags,
         cu.id as customer_id, cu.title as customer_title, cu.tagline as customer_tagline, cu.description as customer_desc, cu.event_tags as customer_tags,
         ms.id as mission_id, ms.title as mission_title, ms.tagline as mission_tagline, ms.description as mission_desc, ms.event_tags as mission_tags, ms.bonus_points,
         rc.id as resources_id, rc.title as resources_title, rc.tagline as resources_tagline, rc.description as resources_desc, rc.event_tags as resources_tags,
         rc.start_cash_l, rc.start_customers, rc.start_reputation, rc.start_innovation,
         t.replacements_used, t.cash_l, t.customers, t.reputation, t.innovation
       from teams t
       join identity_cards mk on mk.id = t.market_card_id
       join identity_cards cu on cu.id = t.customer_card_id
       join identity_cards ms on ms.id = t.mission_card_id
       join identity_cards rc on rc.id = t.resources_card_id
       where t.id = $1`,
      [req.user.teamId]
    );
    res.json(rows[0]);
  })
);

const replaceSchema = z.object({
  category: z.enum(['market', 'customer', 'mission', 'resources']),
  requestId: z.string().uuid(),
});

router.post(
  '/cards/replace',
  actionLimiter,
  validate(replaceSchema),
  h(async (req, res) => {
    const { rows } = await pool.query(
      'select * from fn_replace_identity_card($1, $2, $3)',
      [req.user.teamId, req.body.category, req.body.requestId]
    );
    res.json(rows[0]);
  })
);

// ---------------------------------------------------------------------------
// Company status / dashboard
// ---------------------------------------------------------------------------
router.get(
  '/status',
  h(async (req, res) => {
    const { rows } = await pool.query(
      'select cash_l, customers, reputation, innovation, mission_completed from teams where id = $1',
      [req.user.teamId]
    );
    res.json(rows[0]);
  })
);

// ---------------------------------------------------------------------------
// Live-updates polling: one cheap endpoint every phone hits every few seconds.
// Returns 304-style "no change" when the caller's version is current, so most
// polls cost a single indexed lookup and no payload.
// ---------------------------------------------------------------------------
router.get(
  '/state',
  h(async (req, res) => {
    const clientVersion = req.query.v ? parseInt(req.query.v, 10) : 0;
    const { rows } = await pool.query(
      `select extract(epoch from gs.updated_at)::bigint as game_version,
              (select count(*) from team_action_cards where team_id = $1 and source='r2') as action_card_count,
              (select count(*) from card_plays where other_team_id = $1 and status = 'pending') as pending_deal_offers_in,
              gs.r1_replace_open, gs.r2_selection_open, gs.card_play_open
       from game_state gs where gs.id = 1`,
      [req.user.teamId]
    );
    const row = rows[0];
    const version = Number(row.game_version)
      + Number(row.action_card_count) * 10_000_000_000 + Number(row.pending_deal_offers_in) * 100_000_000_000;
    if (version === clientVersion) {
      return res.status(204).end();
    }
    res.json({ version, ...row });
  })
);

export default router;
