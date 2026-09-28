-- Third Supabase-direct slice: the small polling/status endpoints
-- (fn_player_state, fn_player_status) that feed PlayerApp's live gameState
-- and the Dashboard tab. The old Express /player/state endpoint returned 204
-- when nothing changed, an optimization for the cookie/session world — here
-- the payload is a handful of booleans/counts polled every few seconds, so
-- it's simpler and cheap enough to just return it every tick.

create or replace function fn_player_state()
returns table (
  r1_replace_open boolean, r2_selection_open boolean, card_play_open boolean,
  action_card_count bigint, pending_deal_offers_in bigint
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select gs.r1_replace_open, gs.r2_selection_open, gs.card_play_open,
         (select count(*) from team_action_cards where team_id = au.team_id and source='r2'),
         (select count(*) from card_plays where other_team_id = au.team_id and status = 'pending')
  from game_state gs, fn_auth_user() au
  where gs.id = 1 and au.app_role = 'player'
$$;

grant execute on function fn_player_state() to authenticated;
revoke execute on function fn_player_state() from anon;

create or replace function fn_player_status()
returns table (cash_l int, customers int, reputation smallint, innovation smallint, mission_completed boolean)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select t.cash_l, t.customers, t.reputation, t.innovation, t.mission_completed
  from fn_auth_user() au
  join teams t on t.id = au.team_id
  where au.app_role = 'player'
$$;

grant execute on function fn_player_status() to authenticated;
revoke execute on function fn_player_status() from anon;
