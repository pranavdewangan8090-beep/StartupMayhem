-- Event-day safety + logic fixes (run after 025).
--
--  1. Deal cards: a rejected deal returned the card to 'held', but the
--     table-wide UNIQUE(team_action_card_id) on card_plays then made every
--     re-proposal fail. Also: the initiator could never withdraw an unanswered
--     offer, accepting ignored the card-play toggle and inactive teams, and an
--     unaffordable Cash cost was silently floored to 0 (a free deal).
--  2. Crisis trigger: two super admins pressing at once could both apply the
--     same crisis, and two presses seconds apart fired two different crises.
--     The caller now names the crisis they confirmed, and the trigger is
--     serialized. Triggering also closes R1 replacements — replacing the
--     Resources card resets resources to printed values, which would erase
--     the crisis hit.
--  3. Trading toggle: rows belonging to deactivated super admins kept
--     trading ON with no way to turn them off.
--  4. Team management: deactivation had no undo, and left deals involving
--     the team pending forever. Adds reactivation + an account list for the
--     (previously UI-less) password reset.
--  5. Leaderboard: returns the mission title so the Super Admin can mark
--     missions complete from the UI (fn_super_mark_mission had no UI).

-- ---------------------------------------------------------------------------
-- 1. Deal cards
-- ---------------------------------------------------------------------------
alter table card_plays drop constraint if exists card_plays_team_action_card_id_key;
create unique index if not exists card_plays_one_live_play
  on card_plays (team_action_card_id) where status in ('pending', 'applied');

create or replace function fn_play_deal_card(p_team_action_card_id uuid, p_partner_team_id int, p_request_id uuid)
returns card_plays
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id int;
  v_tac team_action_cards%rowtype;
  v_card action_cards%rowtype;
  v_row card_plays%rowtype;
begin
  select au.team_id into v_team_id from fn_auth_user() au where au.app_role = 'player';
  if v_team_id is null then raise exception 'NOT_AUTHENTICATED'; end if;

  if exists (select 1 from card_plays where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if (select card_play_open from game_state where id = 1) is not true then
    raise exception 'CARD_PLAY_CLOSED';
  end if;
  if p_partner_team_id = v_team_id then raise exception 'CANNOT_TARGET_SELF'; end if;
  if not exists (select 1 from teams where id = p_partner_team_id and is_active) then
    raise exception 'PARTNER_NOT_FOUND';
  end if;

  select * into v_tac from team_action_cards where id = p_team_action_card_id for update;
  if v_tac.id is null or v_tac.team_id <> v_team_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_tac.status <> 'held' then raise exception 'CARD_NOT_AVAILABLE'; end if;

  select * into v_card from action_cards where id = v_tac.action_card_id;
  if v_card.category <> 'deal' then raise exception 'WRONG_CARD_TYPE'; end if;

  if (select cash_l from teams where id = v_team_id) + coalesce((v_card.self_effect->>'cash_l')::int, 0) < 0 then
    raise exception 'INSUFFICIENT_CASH';
  end if;

  update team_action_cards set status = 'pending' where id = p_team_action_card_id;

  insert into card_plays (team_action_card_id, action_card_id, team_id, other_team_id, status, request_id)
  values (p_team_action_card_id, v_card.id, v_team_id, p_partner_team_id, 'pending', p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function fn_play_deal_card(uuid, int, uuid) to authenticated;

create or replace function fn_respond_deal_card(p_card_play_id bigint, p_accept boolean, p_request_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_partner_team_id int;
  v_play card_plays%rowtype;
  v_card action_cards%rowtype;
  v_initiator teams%rowtype;
  v_partner teams%rowtype;
  v_c record;
  v_initiator_after jsonb;
  v_partner_after jsonb;
begin
  select au.team_id into v_partner_team_id from fn_auth_user() au where au.app_role = 'player';
  if v_partner_team_id is null then raise exception 'NOT_AUTHENTICATED'; end if;

  select * into v_play from card_plays where id = p_card_play_id for update;
  if v_play.id is null or v_play.other_team_id <> v_partner_team_id then raise exception 'DEAL_NOT_FOUND'; end if;
  if v_play.status <> 'pending' then raise exception 'DEAL_ALREADY_RESOLVED'; end if;

  select * into v_card from action_cards where id = v_play.action_card_id;

  -- rejecting is always allowed (it just hands the card back); accepting is
  -- a card play, so it respects the same toggle as playing one
  if not p_accept then
    update card_plays set status = 'rejected' where id = p_card_play_id;
    update team_action_cards set status = 'held' where id = v_play.team_action_card_id;
    return jsonb_build_object('accepted', false);
  end if;

  if (select card_play_open from game_state where id = 1) is not true then
    raise exception 'CARD_PLAY_CLOSED';
  end if;

  if v_play.team_id < v_partner_team_id then
    select * into v_initiator from teams where id = v_play.team_id for update;
    select * into v_partner from teams where id = v_partner_team_id for update;
  else
    select * into v_partner from teams where id = v_partner_team_id for update;
    select * into v_initiator from teams where id = v_play.team_id for update;
  end if;

  if not v_initiator.is_active then raise exception 'DEAL_NOT_FOUND'; end if;
  if v_initiator.cash_l + coalesce((v_card.self_effect->>'cash_l')::int, 0) < 0 then
    raise exception 'INITIATOR_INSUFFICIENT_CASH';
  end if;
  if v_partner.cash_l + coalesce((v_card.partner_effect->>'cash_l')::int, 0) < 0 then
    raise exception 'INSUFFICIENT_CASH';
  end if;

  v_c := fn_clamp_team(
    v_initiator.cash_l + coalesce((v_card.self_effect->>'cash_l')::int,0),
    v_initiator.customers + coalesce((v_card.self_effect->>'customers')::int,0),
    v_initiator.reputation + coalesce((v_card.self_effect->>'reputation')::int,0),
    v_initiator.innovation + coalesce((v_card.self_effect->>'innovation')::int,0));
  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = v_play.team_id;

  v_c := fn_clamp_team(
    v_partner.cash_l + coalesce((v_card.partner_effect->>'cash_l')::int,0),
    v_partner.customers + coalesce((v_card.partner_effect->>'customers')::int,0),
    v_partner.reputation + coalesce((v_card.partner_effect->>'reputation')::int,0),
    v_partner.innovation + coalesce((v_card.partner_effect->>'innovation')::int,0));
  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = v_partner_team_id;

  v_initiator_after := fn_team_snapshot(v_play.team_id);
  v_partner_after := fn_team_snapshot(v_partner_team_id);

  update team_action_cards set status = 'used', used_at = now() where id = v_play.team_action_card_id;
  update card_plays set status = 'applied' where id = p_card_play_id;

  return jsonb_build_object('accepted', true, 'initiator_after', v_initiator_after, 'partner_after', v_partner_after);
end;
$$;

grant execute on function fn_respond_deal_card(bigint, boolean, uuid) to authenticated;

-- The initiator withdraws an offer the partner hasn't answered; the deal
-- card goes back to 'held' and can be proposed to someone else.
create or replace function fn_cancel_deal_card(p_card_play_id bigint)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id int;
  v_play card_plays%rowtype;
begin
  select au.team_id into v_team_id from fn_auth_user() au where au.app_role = 'player';
  if v_team_id is null then raise exception 'NOT_AUTHENTICATED'; end if;

  select * into v_play from card_plays where id = p_card_play_id for update;
  if v_play.id is null or v_play.team_id <> v_team_id then raise exception 'DEAL_NOT_FOUND'; end if;
  if v_play.status <> 'pending' then raise exception 'DEAL_ALREADY_RESOLVED'; end if;

  update card_plays set status = 'cancelled' where id = p_card_play_id;
  update team_action_cards set status = 'held' where id = v_play.team_action_card_id;
end;
$$;

grant execute on function fn_cancel_deal_card(bigint) to authenticated;

create or replace function fn_deals_outgoing()
returns table (id bigint, created_at timestamptz, team_action_card_id uuid, name text, to_team_code text)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select cp.id, cp.created_at, cp.team_action_card_id, ac.name, t.team_code
  from fn_auth_user() au
  join card_plays cp on cp.team_id = au.team_id and cp.status = 'pending'
  join action_cards ac on ac.id = cp.action_card_id
  join teams t on t.id = cp.other_team_id
  where au.app_role = 'player'
  order by cp.created_at
$$;

grant execute on function fn_deals_outgoing() to authenticated;

-- fn_player_state gains the two counters the initiator's UI needs to notice
-- its own offer being accepted/rejected (neither changed any existing count).
drop function if exists fn_player_state();
create function fn_player_state()
returns table (
  r1_replace_open boolean, card_play_open boolean,
  action_card_count bigint, pending_deal_offers_in bigint,
  pending_deal_offers_out bigint, used_card_count bigint
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select gs.r1_replace_open, gs.card_play_open,
         (select count(*) from team_action_cards where team_id = au.team_id),
         (select count(*) from card_plays where other_team_id = au.team_id and status = 'pending'),
         (select count(*) from card_plays where team_id = au.team_id and status = 'pending'),
         (select count(*) from team_action_cards where team_id = au.team_id and status = 'used')
  from game_state gs, fn_auth_user() au
  where gs.id = 1 and au.app_role = 'player'
$$;

grant execute on function fn_player_state() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Crisis trigger
-- ---------------------------------------------------------------------------
drop function if exists fn_super_trigger_crisis();
create function fn_super_trigger_crisis(p_crisis_id int)
returns crises
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_row crises%rowtype;
  v_team record;
  v_tier text;
  v_delta jsonb;
  v_c record;
begin
  select user_id into v_actor from fn_require_role(array['super_admin']);

  -- serialize triggers: a concurrent caller waits here, then sees the crisis
  -- already triggered instead of applying it a second time
  perform 1 from game_state where id = 1 for update;

  select * into v_row from crises where not is_triggered order by number limit 1;
  if v_row.id is null then raise exception 'NO_MORE_CRISES'; end if;
  -- the caller confirmed a specific crisis; if someone else got there first,
  -- refuse rather than firing the one after it
  if v_row.id <> p_crisis_id then raise exception 'CRISIS_OUT_OF_ORDER'; end if;

  update crises set is_triggered = true, triggered_at = now(), triggered_by = v_actor
  where id = v_row.id
  returning * into v_row;

  for v_team in select * from teams where is_active for update loop
    select cmt.tier into v_tier from crisis_market_tiers cmt
    where cmt.crisis_id = v_row.id and cmt.market_card_id = v_team.market_card_id;
    if v_tier is null then v_tier := 'unaffected'; end if;

    v_delta := coalesce(v_row.tier_deltas->v_tier, '{}'::jsonb);

    v_c := fn_clamp_team(
      v_team.cash_l + coalesce((v_delta->>'cash_l')::int, 0),
      v_team.customers + coalesce((v_delta->>'customers')::int, 0),
      v_team.reputation + coalesce((v_delta->>'reputation')::int, 0),
      v_team.innovation + coalesce((v_delta->>'innovation')::int, 0)
    );

    update teams set
      cash_l = v_c.f1, customers = v_c.f2, reputation = v_c.f3, innovation = v_c.f4,
      decision_points = decision_points + coalesce((v_delta->>'decision_points')::int, 0)
    where id = v_team.id;

    insert into crisis_team_effects (crisis_id, team_id, tier, applied)
    values (v_row.id, v_team.id, v_tier, v_delta)
    on conflict (crisis_id, team_id) do update set tier = excluded.tier, applied = excluded.applied;
  end loop;

  update game_state set r1_replace_open = false, updated_at = now() where id = 1;

  return v_row;
end;
$$;

grant execute on function fn_super_trigger_crisis(int) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Trading toggle: only active super admins count
-- ---------------------------------------------------------------------------
create or replace function fn_trading_enabled()
returns boolean
language sql security definer stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from trade_feature_toggles tft
    join users u on u.id = tft.super_admin_id
    where tft.enabled and u.is_active and u.role = 'super_admin'
  )
$$;

create or replace function fn_trade_feature_status()
returns table (enabled boolean, mine boolean)
language plpgsql security definer stable
set search_path = public, pg_temp
as $$
declare
  v_au record;
begin
  select * into v_au from fn_require_role(array['admin','super_admin']) r;
  return query select
    fn_trading_enabled(),
    case when v_au.app_role = 'super_admin'
      then coalesce((select tft.enabled from trade_feature_toggles tft where tft.super_admin_id = v_au.user_id), false)
      else null end;
end;
$$;

grant execute on function fn_trade_feature_status() to authenticated;

create or replace function fn_admin_process_trade(
  p_team_a_id int, p_team_a_card_id uuid,
  p_team_b_id int, p_team_b_card_id uuid,
  p_money_team_id int, p_money_amount int,
  p_crisis_id int, p_request_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_card_a team_action_cards%rowtype;
  v_card_b team_action_cards%rowtype;
  v_category_a text;
  v_category_b text;
  v_payee_id int;
begin
  select user_id into v_actor from fn_require_role(array['admin','super_admin']);

  if exists (select 1 from trades where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if not fn_trading_enabled() then
    raise exception 'TRADING_DISABLED';
  end if;
  if p_team_a_id = p_team_b_id then raise exception 'CANNOT_TRADE_SELF'; end if;
  if (select count(*) from teams where id in (p_team_a_id, p_team_b_id) and is_active) <> 2 then
    raise exception 'TEAM_NOT_FOUND';
  end if;
  if coalesce(p_money_amount, 0) < 0 then raise exception 'BAD_MONEY_AMOUNT'; end if;
  if coalesce(p_money_amount, 0) > 0 and p_money_team_id is null then
    raise exception 'MONEY_TEAM_INVALID';
  end if;
  if p_money_team_id is not null and p_money_team_id not in (p_team_a_id, p_team_b_id) then
    raise exception 'MONEY_TEAM_INVALID';
  end if;

  -- lock both card rows in a fixed order (by uuid text) to avoid deadlocks
  if p_team_a_card_id::text < p_team_b_card_id::text then
    select * into v_card_a from team_action_cards where id = p_team_a_card_id for update;
    select * into v_card_b from team_action_cards where id = p_team_b_card_id for update;
  else
    select * into v_card_b from team_action_cards where id = p_team_b_card_id for update;
    select * into v_card_a from team_action_cards where id = p_team_a_card_id for update;
  end if;

  if v_card_a.id is null or v_card_a.team_id <> p_team_a_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_card_b.id is null or v_card_b.team_id <> p_team_b_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_card_a.status <> 'held' or v_card_b.status <> 'held' then raise exception 'CARD_NOT_AVAILABLE'; end if;

  select category into v_category_a from action_cards where id = v_card_a.action_card_id;
  select category into v_category_b from action_cards where id = v_card_b.action_card_id;
  if (v_category_a = 'deal') <> (v_category_b = 'deal') then
    raise exception 'DEAL_TRADES_ONLY_WITH_DEAL';
  end if;

  if coalesce(p_money_amount, 0) > 0 then
    perform 1 from teams where id = least(p_team_a_id, p_team_b_id) for update;
    perform 1 from teams where id = greatest(p_team_a_id, p_team_b_id) for update;

    v_payee_id := case when p_money_team_id = p_team_a_id then p_team_b_id else p_team_a_id end;

    if (select cash_l from teams where id = p_money_team_id) < p_money_amount then
      raise exception 'INSUFFICIENT_CASH';
    end if;
    update teams set cash_l = cash_l - p_money_amount where id = p_money_team_id;
    update teams set cash_l = cash_l + p_money_amount where id = v_payee_id;
  end if;

  update team_action_cards set team_id = p_team_b_id, source = 'admin' where id = p_team_a_card_id;
  update team_action_cards set team_id = p_team_a_id, source = 'admin' where id = p_team_b_card_id;

  insert into trades (crisis_id, team_a_id, team_a_card_id, team_b_id, team_b_card_id, money_team_id, money_amount, processed_by, request_id)
  values (p_crisis_id, p_team_a_id, p_team_a_card_id, p_team_b_id, p_team_b_card_id, p_money_team_id, coalesce(p_money_amount, 0), v_actor, p_request_id);

  if p_crisis_id is not null then
    update crisis_affected_teams
    set status = 'traded', updated_at = now(), updated_by = v_actor
    where crisis_id = p_crisis_id and status = 'pending' and (
      (team_id = p_team_a_id and v_card_b.action_card_id in (select action_card_id from crisis_useful_cards where crisis_id = p_crisis_id))
      or
      (team_id = p_team_b_id and v_card_a.action_card_id in (select action_card_id from crisis_useful_cards where crisis_id = p_crisis_id))
    );
  end if;

  return jsonb_build_object(
    'teamACardId', p_team_a_card_id, 'teamBCardId', p_team_b_card_id,
    'teamAId', p_team_a_id, 'teamBId', p_team_b_id
  );
end;
$$;

grant execute on function fn_admin_process_trade(int, uuid, int, uuid, int, int, int, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Team management
-- ---------------------------------------------------------------------------
-- Deactivating also withdraws every pending deal involving the team, so no
-- other team's deal card stays stuck on an offer that can never be answered.
create or replace function fn_super_deactivate_team(p_team_id int)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from fn_require_role(array['super_admin']);
  update teams set is_active = false where id = p_team_id;
  update users set is_active = false where team_id = p_team_id;

  update team_action_cards set status = 'held'
  where id in (select team_action_card_id from card_plays
               where status = 'pending' and (team_id = p_team_id or other_team_id = p_team_id));
  update card_plays set status = 'cancelled'
  where status = 'pending' and (team_id = p_team_id or other_team_id = p_team_id);
end;
$$;

grant execute on function fn_super_deactivate_team(int) to authenticated;

create or replace function fn_super_reactivate_team(p_team_id int)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from fn_require_role(array['super_admin']);
  update teams set is_active = true where id = p_team_id;
  if not found then raise exception 'TEAM_NOT_FOUND'; end if;
  update users set is_active = true where team_id = p_team_id;
end;
$$;

grant execute on function fn_super_reactivate_team(int) to authenticated;

-- Every account (active or not), for the Manage Teams tab: team rows with
-- their login + reactivate/reset controls, and staff rows for password reset.
create or replace function fn_super_accounts()
returns table (
  user_id uuid, role text, login_id text, user_active boolean,
  team_id int, team_code text, team_active boolean, market_title text, customer_title text
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select u.id, u.role, u.login_id, u.is_active,
         t.id, t.team_code, t.is_active, mk.title, cu.title
  from fn_require_role(array['super_admin']) au
  cross join users u
  left join teams t on t.id = u.team_id
  left join identity_cards mk on mk.id = t.market_card_id
  left join identity_cards cu on cu.id = t.customer_card_id
  order by case u.role when 'player' then 0 when 'admin' then 1 else 2 end,
           coalesce(t.team_code, u.login_id)
$$;

grant execute on function fn_super_accounts() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Leaderboard: include mission title for the mark-complete control
-- ---------------------------------------------------------------------------
drop function if exists fn_super_leaderboard_raw();
create function fn_super_leaderboard_raw()
returns table (
  team_id int, team_code text, cash_l int, customers int, reputation smallint, innovation smallint,
  mission_completed boolean, decision_points int, bonus_points smallint, mission_title text
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select t.id, t.team_code, t.cash_l, t.customers, t.reputation, t.innovation,
         t.mission_completed, t.decision_points, mc.bonus_points, mc.title
  from fn_require_role(array['super_admin']) au
  join teams t on t.is_active
  left join identity_cards mc on mc.id = t.mission_card_id
  order by t.team_code
$$;

grant execute on function fn_super_leaderboard_raw() to authenticated;

-- Re-assert 025's lockdown for everything created above (belt and braces in
-- case this project's default privileges still grant new functions to
-- anon), and keep the internal helper off the API entirely.
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
revoke execute on function fn_trading_enabled() from authenticated;
grant execute on function fn_login(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
