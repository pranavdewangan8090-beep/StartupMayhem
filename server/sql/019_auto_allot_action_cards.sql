-- Action cards are no longer requested by teams. Every team is auto-issued
-- one random card per category (action/deal/special) the moment it's
-- created, so it's already in their hand the first time they log in. The
-- only way to change hands after that is an admin-processed trade in Round 3
-- (see 016-018). The `source = 'r2'` value on team_action_cards is kept
-- as-is (no schema churn) — it now just means "part of the starting hand"
-- rather than "requested during the old Round 2 flow".

-- ---------------------------------------------------------------------------
-- Remove the request feature entirely.
-- ---------------------------------------------------------------------------
drop function if exists fn_r2_request_card(int, int, uuid); -- legacy Express-era overload (005)
drop function if exists fn_r2_request_card(int, uuid);      -- player-facing overload (012)

-- ---------------------------------------------------------------------------
-- Auto-allotment helper + wiring into team creation.
-- ---------------------------------------------------------------------------
create or replace function fn_issue_starting_hand(p_team_id int)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_category text;
  v_card_id int;
begin
  foreach v_category in array array['action', 'deal', 'special'] loop
    if not exists (
      select 1 from team_action_cards tac join action_cards ac on ac.id = tac.action_card_id
      where tac.team_id = p_team_id and ac.category = v_category
    ) then
      select id into v_card_id from action_cards where category = v_category and is_active
      order by random() limit 1;
      insert into team_action_cards (team_id, action_card_id, status, source)
      values (p_team_id, v_card_id, 'held', 'r2');
    end if;
  end loop;
end;
$$;

create or replace function fn_super_add_team(p_team_code text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_market identity_cards%rowtype;
  v_customer identity_cards%rowtype;
  v_mission identity_cards%rowtype;
  v_resources identity_cards%rowtype;
  v_team_id int;
  v_password text;
begin
  perform 1 from fn_require_role(array['super_admin']);

  select * into v_market from identity_cards where category = 'market' order by random() limit 1;
  select * into v_customer from identity_cards where category = 'customer' order by random() limit 1;
  select * into v_mission from identity_cards where category = 'mission' order by random() limit 1;
  select * into v_resources from identity_cards where category = 'resources' order by random() limit 1;

  insert into teams (team_code, cash_l, customers, reputation, innovation,
    market_card_id, customer_card_id, mission_card_id, resources_card_id)
  values (p_team_code, v_resources.start_cash_l, v_resources.start_customers,
    v_resources.start_reputation, v_resources.start_innovation,
    v_market.id, v_customer.id, v_mission.id, v_resources.id)
  returning id into v_team_id;

  v_password := fn_random_password();
  insert into users (role, login_id, password_hash, team_id)
  values ('player', p_team_code, crypt(v_password, gen_salt('bf')), v_team_id);

  perform fn_issue_starting_hand(v_team_id);

  return jsonb_build_object('teamId', v_team_id, 'teamCode', p_team_code, 'password', v_password);
end;
$$;

-- Backfill: any team created before this change that's missing a category
-- gets it now (idempotent — safe to re-run).
do $$
declare v_team_id int;
begin
  for v_team_id in select id from teams where is_active loop
    perform fn_issue_starting_hand(v_team_id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Retire the R2 toggle: no more request step to gate.
-- ---------------------------------------------------------------------------
alter table game_state drop column if exists r2_selection_open;

create or replace function fn_super_toggles_set(p_key text, p_value boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from fn_require_role(array['super_admin']);
  if p_key not in ('r1_replace_open', 'card_play_open') then
    raise exception 'BAD_TOGGLE_KEY';
  end if;
  execute format('update game_state set %I = $1, updated_at = now() where id = 1', p_key) using p_value;
end;
$$;

-- CREATE OR REPLACE can't change a RETURNS TABLE column list, so drop first.
drop function if exists fn_player_state();

create or replace function fn_player_state()
returns table (
  r1_replace_open boolean, card_play_open boolean,
  action_card_count bigint, pending_deal_offers_in bigint
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select gs.r1_replace_open, gs.card_play_open,
         (select count(*) from team_action_cards where team_id = au.team_id),
         (select count(*) from card_plays where other_team_id = au.team_id and status = 'pending')
  from game_state gs, fn_auth_user() au
  where gs.id = 1 and au.app_role = 'player'
$$;

grant execute on function fn_player_state() to authenticated;
revoke execute on function fn_player_state() from anon;
