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

// Tab 1: the marketplace, split into "mine" and "others" as the spec asks.
router.get(
  '/listings',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select ml.id as listing_id, ml.seller_team_id, t.team_code as seller_team_code, ml.created_at,
              ac.id as action_card_id, ac.category, ac.name, ac.description, ac.effect_text
       from market_listings ml
       join team_action_cards tac on tac.id = ml.team_action_card_id
       join action_cards ac on ac.id = tac.action_card_id
       join teams t on t.id = ml.seller_team_id
       where ml.status = 'active'
       order by ml.created_at desc`
    );
    res.json({
      mine: rows.filter((r) => r.seller_team_id === req.user.teamId),
      others: rows.filter((r) => r.seller_team_id !== req.user.teamId),
    });
  })
);

const listSchema = z.object({ teamActionCardId: z.string().uuid(), requestId: z.string().uuid() });
router.post(
  '/list',
  actionLimiter,
  validate(listSchema),
  h(async (req, res) => {
    const { rows } = await pool.query('select * from fn_list_card($1, $2, $3)', [
      req.user.teamId, req.body.teamActionCardId, req.body.requestId,
    ]);
    res.json(rows[0]);
  })
);

// listingId is a bigserial primary key — pg returns bigint columns as
// strings (to avoid precision loss past 2^53), so this must coerce rather
// than require an already-numeric JSON value.
const unlistSchema = z.object({ listingId: z.coerce.number().int().positive(), requestId: z.string().uuid() });
router.post(
  '/unlist',
  actionLimiter,
  validate(unlistSchema),
  h(async (req, res) => {
    await pool.query('select fn_unlist_card($1, $2, $3)', [req.user.teamId, req.body.listingId, req.body.requestId]);
    res.json({ ok: true });
  })
);

// The buyer's own held cards, to pick what to offer in trade for a listing.
router.get(
  '/my-tradable-cards',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select tac.id, ac.name, ac.category from team_action_cards tac
       join action_cards ac on ac.id = tac.action_card_id
       where tac.team_id = $1 and tac.status = 'held'`,
      [req.user.teamId]
    );
    res.json(rows);
  })
);

const offerSchema = z.object({
  listingId: z.coerce.number().int().positive(),
  offeredTeamActionCardId: z.string().uuid(),
  requestId: z.string().uuid(),
});
router.post(
  '/offer',
  actionLimiter,
  validate(offerSchema),
  h(async (req, res) => {
    const { rows } = await pool.query('select * from fn_make_trade_offer($1, $2, $3, $4)', [
      req.user.teamId, req.body.listingId, req.body.offeredTeamActionCardId, req.body.requestId,
    ]);
    res.json(rows[0]);
  })
);

// Tab 2: trade requests received on the team's own listings.
router.get(
  '/offers/received',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `select o.id as offer_id, o.listing_id, o.created_at,
              buyer.team_code as buyer_team_code,
              lac.name as listed_card_name, oac.name as offered_card_name
       from trade_offers o
       join market_listings ml on ml.id = o.listing_id
       join teams buyer on buyer.id = o.buyer_team_id
       join team_action_cards ltac on ltac.id = ml.team_action_card_id
       join action_cards lac on lac.id = ltac.action_card_id
       join team_action_cards otac on otac.id = o.offered_card_id
       join action_cards oac on oac.id = otac.action_card_id
       where ml.seller_team_id = $1 and o.status = 'pending'
       order by o.created_at`,
      [req.user.teamId]
    );
    res.json(rows);
  })
);

const respondOfferSchema = z.object({ offerId: z.coerce.number().int().positive(), accept: z.boolean(), requestId: z.string().uuid() });
router.post(
  '/offers/respond',
  actionLimiter,
  validate(respondOfferSchema),
  h(async (req, res) => {
    const { rows } = await pool.query('select fn_respond_trade_offer($1, $2, $3, $4) as result', [
      req.user.teamId, req.body.offerId, req.body.accept, req.body.requestId,
    ]);
    res.json(rows[0].result);
  })
);

export default router;
