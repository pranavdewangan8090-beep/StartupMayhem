import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { actionLimiter } from '../middleware/rateLimit.js';
import { h } from '../lib/errors.js';

const router = Router();
router.use(requireAuth);

// Everyone (players, admins, super admins) can see the currently active
// mayhem — it must show on both the Super Admin side and every team's phone.
router.get(
  '/current',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select me.id as event_id, me.triggered_at, m.title, m.description, m.effect_text, m.tags
       from game_state gs
       join mayhem_events me on me.id = gs.current_mayhem_event_id
       join mayhems m on m.id = me.mayhem_id
       where gs.id = 1`
    );
    res.json(rows[0] || null);
  })
);

// Admins/Super Admins only: which teams hold a card or identity-card ability
// that protects them from the CURRENT mayhem, so they can decide manually
// whether to apply the effect.
router.get(
  '/protections',
  requireRole('admin', 'super_admin'),
  h(async (req, res) => {
    const { rows: mrows } = await pool.query(
      `select m.id as mayhem_id, m.tags from game_state gs
       join mayhem_events me on me.id = gs.current_mayhem_event_id
       join mayhems m on m.id = me.mayhem_id
       where gs.id = 1`
    );
    const mayhem = mrows[0];
    if (!mayhem) return res.json({ specialCardHolders: [], taggedIdentityCardHolders: [] });

    const { rows: specialCardHolders } = await pool.query(
      `select t.id as team_id, t.team_code, ac.name as card_name
       from mayhem_protections mp
       join action_cards ac on ac.id = mp.action_card_id
       join team_action_cards tac on tac.action_card_id = ac.id and tac.status = 'held'
       join teams t on t.id = tac.team_id
       where mp.mayhem_id = $1`,
      [mayhem.mayhem_id]
    );

    // Teams whose identity cards react to one of this mayhem's tags (informational —
    // exact effect still applied manually per Section 8 of the game rules)
    const { rows: taggedIdentityCardHolders } = await pool.query(
      `select t.id as team_id, t.team_code, ic.title as card_title, ic.category, ic.description
       from teams t
       join lateral (
         select * from identity_cards where id in
           (t.market_card_id, t.customer_card_id, t.problem_card_id, t.mission_card_id, t.resources_card_id)
       ) ic on true
       where ic.event_tags && $1 or ic.event_tags @> array['any']::text[]`,
      [mayhem.tags]
    );

    res.json({ specialCardHolders, taggedIdentityCardHolders });
  })
);

const triggerSchema = z.object({ requestId: z.string().uuid() });
router.post(
  '/trigger',
  actionLimiter,
  requireRole('super_admin'),
  validate(triggerSchema),
  h(async (req, res) => {
    const { rows } = await pool.query('select * from fn_trigger_mayhem($1, $2)', [req.user.id, req.body.requestId]);
    res.json(rows[0]);
  })
);

export default router;
