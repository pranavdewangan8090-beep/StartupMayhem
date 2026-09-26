// Every game-rule violation is raised inside a Postgres function as a plain
// RAISE EXCEPTION '<CODE>'. This maps those codes to an HTTP status and a
// player-safe message, so every route gets consistent error handling for free
// by calling `mapPgError(err)` in its catch block.
const CODE_MAP = {
  DUPLICATE_REQUEST: [409, 'This action was already submitted.'],
  TEAM_NOT_FOUND: [404, 'Team not found.'],
  BAD_CATEGORY: [400, 'Unknown card category.'],
  REPLACEMENTS_CLOSED: [403, 'Card replacement is closed.'],
  REPLACEMENT_LIMIT_REACHED: [403, 'You have used all 3 card replacements.'],
  R2_CLOSED: [403, 'Action card selection is closed.'],
  R2_LIMIT_REACHED: [403, 'You already have 4 action cards.'],
  ALREADY_HAVE_CARD: [409, 'You already requested this card.'],
  CATEGORY_ALREADY_TAKEN: [409, 'You already have a card from this category.'],
  CARD_PLAY_CLOSED: [403, 'Playing action cards is closed right now.'],
  CARD_NOT_FOUND: [404, 'Card not found.'],
  CARD_NOT_AVAILABLE: [409, 'That card cannot be used right now.'],
  WRONG_CARD_TYPE: [400, 'Wrong card type for this action.'],
  INSUFFICIENT_CASH: [402, 'Not enough Cash to play this card.'],
  CANNOT_TARGET_SELF: [400, 'You cannot target your own team.'],
  TARGET_NOT_FOUND: [404, 'Target team not found.'],
  PARTNER_NOT_FOUND: [404, 'Partner team not found.'],
  DEAL_NOT_FOUND: [404, 'Deal offer not found.'],
  DEAL_ALREADY_RESOLVED: [409, 'This deal was already resolved.'],
  MARKETPLACE_CLOSED: [403, 'The marketplace is closed right now.'],
  LISTING_NOT_FOUND: [404, 'Listing not found.'],
  LISTING_NOT_ACTIVE: [409, 'That listing is no longer active.'],
  OFFERED_CARD_NOT_FOUND: [404, 'Offered card not found.'],
  OFFERED_CARD_NOT_AVAILABLE: [409, 'That card is not available to trade.'],
  CANNOT_TRADE_WITH_SELF: [400, 'You cannot trade with your own team.'],
  OFFER_NOT_FOUND: [404, 'Trade offer not found.'],
  OFFER_ALREADY_RESOLVED: [409, 'This trade offer was already resolved.'],
  NOT_YOUR_LISTING: [403, 'This is not your listing.'],
  NO_MORE_EVENTS: [409, 'All 3 Market Mayhem events have already been triggered.'],
  EVENT_NOT_FOUND: [404, 'Mayhem event not found.'],
  TIER_NOT_FOUND: [500, 'No tier configured for this team’s Market card.'],
  BAD_RESPONSE: [400, 'Unknown response type.'],
  PARTNER_REQUIRED: [400, 'A partner team is required for this response.'],
};

export function mapPgError(err) {
  const code = (err?.message || '').trim();
  if (CODE_MAP[code]) {
    const [status, message] = CODE_MAP[code];
    return { status, body: { error: code, message } };
  }
  // Postgres CHECK constraint violations etc. should not leak internals to the client
  if (err?.code === '23514' || err?.code === '23505') {
    return { status: 400, body: { error: 'INVALID_INPUT', message: 'That change is not allowed.' } };
  }
  console.error('Unhandled error', err);
  return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Something went wrong.' } };
}

/** Wraps an async Express handler so thrown errors reach mapPgError automatically. */
export function h(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      const { status, body } = mapPgError(err);
      res.status(status).json(body);
    }
  };
}
