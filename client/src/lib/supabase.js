// Talks to Supabase directly from the browser — no Express server. Auth is
// custom (not Supabase Auth/GoTrue): fn_login mints a JWT signed with this
// project's own JWT secret (see server/sql/010_supabase_auth.sql), PostgREST
// verifies it like any other Supabase Auth token, and every RLS policy / RPC
// function reads the caller's identity back out via fn_auth_user().
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const TOKEN_KEY = 'sm_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable — session just won't survive a reload */ }
}

// The `accessToken` callback is supabase-js's supported hook for exactly this
// "bring your own JWT" pattern — it's read fresh on every request, so
// swapping the stored token (login/logout) takes effect immediately without
// recreating the client.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  accessToken: async () => getToken() ?? undefined,
});

// A RAISE EXCEPTION '<CODE>' inside a Postgres function comes back from
// PostgREST as error.message = '<CODE>' verbatim (fn_login is the one
// exception — see throwIfLoginError below) — this mirrors the player-safe
// copy the old Express API used to show.
const CODE_MAP = {
  INVALID_CREDENTIALS: 'Wrong ID or password.',
  RATE_LIMITED: 'Too many login attempts. Wait a few minutes and try again.',
  DUPLICATE_REQUEST: 'This action was already submitted.',
  TEAM_NOT_FOUND: 'Team not found.',
  BAD_CATEGORY: 'Unknown card category.',
  REPLACEMENTS_CLOSED: 'Card replacement is closed.',
  REPLACEMENT_LIMIT_REACHED: 'You have used all 3 card replacements.',
  CARD_PLAY_CLOSED: 'Playing action cards is closed right now.',
  CARD_NOT_FOUND: 'Card not found.',
  CARD_NOT_AVAILABLE: 'That card cannot be used right now.',
  WRONG_CARD_TYPE: 'Wrong card type for this action.',
  INSUFFICIENT_CASH: 'Not enough Cash to play this card.',
  CANNOT_TARGET_SELF: 'You cannot target your own team.',
  TARGET_NOT_FOUND: 'Target team not found.',
  PARTNER_NOT_FOUND: 'Partner team not found.',
  DEAL_NOT_FOUND: 'Deal offer not found.',
  DEAL_ALREADY_RESOLVED: 'This deal was already resolved.',
  NO_MORE_CRISES: 'All crises have already been triggered.',
  CRISIS_NOT_FOUND: 'Crisis not found.',
  BAD_STATUS: 'Unknown crisis status.',
  TEAM_NOT_AFFECTED: 'That team is not listed as affected by this crisis.',
  TRADING_DISABLED: 'Card trading is currently switched off by the Super Admins.',
  CANNOT_TRADE_SELF: 'A team cannot trade with itself.',
  DEAL_TRADES_ONLY_WITH_DEAL: 'A Deal card can only be traded for another Deal card.',
  BAD_MONEY_AMOUNT: 'The money amount cannot be negative.',
  MONEY_TEAM_INVALID: 'The paying team must be one of the two teams in the trade.',
  NOT_AUTHENTICATED: 'Your session has ended — please log in again.',
  INITIATOR_INSUFFICIENT_CASH: 'The team that proposed this deal no longer has enough Cash for it.',
  CRISIS_OUT_OF_ORDER: 'Another Super Admin already triggered that crisis. The list has been refreshed — check it before triggering again.',
  USER_NOT_FOUND: 'Account not found.',
  PARTNER_HAS_NO_DEAL_CARD: "That team doesn't have a Deal card available right now — they may have already used or traded theirs.",
  YOUR_DEAL_CARD_UNAVAILABLE: 'Your own Deal card is no longer available (used or traded since this offer was made), so it can\'t be paired for this deal.',
  NO_CARDS_AVAILABLE_IN_CATEGORY: 'No more copies of any card in that category are available (each card is limited to 3 teams).',
  CANNOT_MERGE_SAME_TEAM: 'A team cannot be merged with itself.',
};

// Fired whenever a call proves the stored token no longer identifies anyone
// (this team logged in on another phone, the account was deactivated, or the
// JWT expired). AuthContext listens and sends the user back to the login
// screen with an explanation, instead of leaving a silently frozen UI.
export const SESSION_INVALID_EVENT = 'sm:session-invalid';

export function reportSessionInvalid() {
  window.dispatchEvent(new Event(SESSION_INVALID_EVENT));
}

function isSessionError(error, code) {
  return code === 'NOT_AUTHENTICATED' || error.code === 'PGRST301' || /jwt expired/i.test(error.message || '');
}

export class ApiError extends Error {
  constructor(message, code) {
    super(message || 'Request failed');
    this.code = code;
  }
}

/** Wraps a supabase-js call, throwing ApiError on failure so callers can
 * keep the same try/catch shape the old fetch-based client used. */
export async function call(promise) {
  const { data, error } = await promise;
  if (error) {
    const code = (error.message || '').trim();
    if (getToken() && isSessionError(error, code)) reportSessionInvalid();
    throw new ApiError(CODE_MAP[code] || error.message, code);
  }
  return data;
}

/** fn_login reports a credential/rate-limit failure by returning
 * {error: CODE} normally rather than raising (see server/sql/015 for why),
 * so it can't go through call()'s error-branch above — this throws from
 * that shape instead, mapped through the same CODE_MAP. */
export function throwIfLoginError(result) {
  if (result?.error) throw new ApiError(CODE_MAP[result.error] || result.error, result.error);
  return result;
}

export function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
