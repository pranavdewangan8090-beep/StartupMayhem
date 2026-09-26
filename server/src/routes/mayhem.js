import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { actionLimiter } from '../middleware/rateLimit.js';
import { h } from '../lib/errors.js';

const router = Router();
// Round 3: Market Mayhem is entirely an Admin/Super Admin tool — players
// never see it or respond themselves (Admins record each team's response
// from the paper GM Guide).
router.use(requireAuth, requireRole('admin', 'super_admin'));

// The currently-triggered event (or null before Round 3 starts / between events).
router.get(
  '/current',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select e.id as mayhem_event_id, e.number, e.triggered_at, e.title, e.story_text, e.effect_text, e.tags
       from game_state gs
       join mayhem_events e on e.id = gs.current_mayhem_event_id
       where gs.id = 1`
    );
    res.json(rows[0] || null);
  })
);

// All 3 events with trigger status, so the Super Admin can see round progress.
router.get(
  '/events',
  h(async (req, res) => {
    const { rows } = await pool.query(
      'select id, number, title, is_triggered, triggered_at from mayhem_events order by number'
    );
    res.json(rows);
  })
);

router.post(
  '/trigger',
  actionLimiter,
  requireRole('super_admin'),
  h(async (req, res) => {
    const { rows } = await pool.query('select * from fn_trigger_mayhem_event($1)', [req.user.id]);
    res.json(rows[0]);
  })
);

// For the currently-triggered event: every team, its Market card's tier, and
// whether (and how) a response has already been recorded for it.
router.get(
  '/team-status',
  h(async (req, res) => {
    const { rows: gsRows } = await pool.query('select current_mayhem_event_id from game_state where id = 1');
    const eventId = gsRows[0]?.current_mayhem_event_id;
    if (!eventId) return res.json([]);

    const { rows } = await pool.query(
      `select t.id as team_id, t.team_code, mk.title as market_title, mt.tier,
              r.response, r.partner_team_id, r.applied, pt.team_code as partner_team_code
       from teams t
       join identity_cards mk on mk.id = t.market_card_id
       left join market_tiers mt on mt.mayhem_event_id = $1 and mt.market_card_id = t.market_card_id
       left join team_mayhem_responses r on r.mayhem_event_id = $1 and r.team_id = t.id
       left join teams pt on pt.id = r.partner_team_id
       where t.is_active
       order by case mt.tier
                  when 'hit_hard' then 0
                  when 'hit' then 1
                  when 'unaffected' then 2
                  when 'gains' then 3
                  else 4
                end,
                t.team_code`,
      [eventId]
    );
    res.json(rows);
  })
);

const respondSchema = z.object({
  teamId: z.number().int().positive(),
  response: z.enum(['accept', 'spend', 'adapt', 'partner']),
  partnerTeamId: z.number().int().positive().nullable().optional(),
  requestId: z.string().uuid(),
});
router.post(
  '/respond',
  actionLimiter,
  validate(respondSchema),
  h(async (req, res) => {
    const { rows: gsRows } = await pool.query('select current_mayhem_event_id from game_state where id = 1');
    const eventId = gsRows[0]?.current_mayhem_event_id;
    if (!eventId) return res.status(409).json({ error: 'EVENT_NOT_FOUND', message: 'No Market Mayhem event is currently active.' });

    const b = req.body;
    const { rows } = await pool.query(
      'select * from fn_record_mayhem_response($1,$2,$3,$4,$5,$6)',
      [req.user.id, b.teamId, eventId, b.response, b.partnerTeamId ?? null, b.requestId]
    );
    res.json(rows[0]);
  })
);

export default router;
