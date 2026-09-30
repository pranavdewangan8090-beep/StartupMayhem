-- Security fix: function EXECUTE grants.
--
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and
-- anon/authenticated are members of PUBLIC — so every
-- `revoke execute ... from anon` in 011-024 was a no-op: anon could still
-- call every function through PUBLIC. For most RPCs that was harmless (they
-- check fn_auth_user()/fn_require_role() themselves), but
-- fn_current_jwt_secret() is SECURITY DEFINER with no check at all, so
-- anyone holding the public anon key could read the JWT secret via
-- POST /rest/v1/rpc/fn_current_jwt_secret and mint a service_role token.
--
-- After this file, a function is callable from the API only if it has an
-- explicit grant: fn_login for anon, and the app RPCs for authenticated
-- (those grants were already made explicitly in 010-024 and survive this).
-- Internal helpers (fn_current_jwt_secret, fn_clamp_team, fn_team_snapshot,
-- fn_issue_starting_hand, ...) are only ever called from inside SECURITY
-- DEFINER functions, which run as their owner, so they need no grant.
--
-- AFTER APPLYING THIS: rotate the project's JWT secret (it may already have
-- been read) and update the _app_secrets row + both .env anon keys.

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
-- Supabase's own default grants to anon are global (not per-schema), and a
-- schema-scoped ALTER DEFAULT PRIVILEGES can't subtract from a global one —
-- so this has to be the global form too.
alter default privileges revoke execute on functions from public;
alter default privileges revoke execute on functions from anon;

revoke execute on function fn_current_jwt_secret() from authenticated;

-- fn_login is the one function the logged-out browser must reach.
grant execute on function fn_login(text, text, text) to anon, authenticated;

-- Legacy Express-era overloads (005) that took a caller-supplied team id.
-- Nothing calls them any more; they only widened the API surface.
drop function if exists fn_admin_adjust_resources(int, int, int, int, int);
drop function if exists fn_admin_adjust_decision_points(int, int);
drop function if exists fn_play_self_card(int, uuid, uuid);
drop function if exists fn_play_deal_card(int, uuid, int, uuid);
drop function if exists fn_respond_deal_card(int, bigint, boolean, uuid);
drop function if exists fn_replace_identity_card(int, text, uuid);
drop function if exists fn_clamp_team_mayhem(int, int, int, int);

notify pgrst, 'reload schema';
