-- Second Supabase-direct vertical slice: player action cards (catalog, hand,
-- request, play self/deal, respond to deals). Same pattern as 011: new
-- SECURITY DEFINER functions that derive the caller's team from
-- fn_auth_user() instead of trusting a client-supplied team id, added as
-- overloads alongside the originals so the still-running Express routes
-- (which pass an explicit, server-validated team id) keep working untouched.

-- Catalog is static/non-team-specific, but still curated to the same 5
-- columns the old Express route returned (not the raw self_effect/
-- partner_effect JSON, which the UI never showed pre-reveal).
create or replace function fn_action_card_catalog()
returns table (id int, category text, name text, description text, effect_text text)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select id, category, name, description, effect_text
  from action_cards where is_active order by category, name
$$;

grant execute on function fn_action_card_catalog() to authenticated;
revoke execute on function fn_action_card_catalog() from anon;

create or replace function fn_player_hand()
returns table (
  id uuid, status text, source text, acquired_at timestamptz,
  action_card_id int, category text, name text, description text, effect_text text
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select tac.id, tac.status, tac.source, tac.acquired_at,
         ac.id, ac.category, ac.name, ac.description, ac.effect_text
  from fn_auth_user() au
  join team_action_cards tac on tac.team_id = au.team_id
  join action_cards ac on ac.id = tac.action_card_id
  where au.app_role = 'player'
  order by tac.acquired_at
$$;

grant execute on function fn_player_hand() to authenticated;
revoke execute on function fn_player_hand() from anon;

-- Deal partner picker: id + team_code only, excluding the caller's own team —
-- never resources or decision points.
create or replace function fn_other_teams()
returns table (id int, team_code text)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select t.id, t.team_code from teams t, fn_auth_user() au
  where t.is_active and t.id <> au.team_id and au.app_role = 'player'
  order by t.team_code
$$;

grant execute on function fn_other_teams() to authenticated;
revoke execute on function fn_other_teams() from anon;

create or replace function fn_r2_request_card(p_action_card_id int, p_request_id uuid)
returns team_action_cards
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id int;
  v_count int;
  v_category text;
  v_row team_action_cards%rowtype;
begin
  select au.team_id into v_team_id from fn_auth_user() au where au.app_role = 'player';
  if v_team_id is null then raise exception 'NOT_AUTHENTICATED'; end if;

  if exists (select 1 from team_action_cards where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;

  perform 1 from teams where id = v_team_id for update;

  if (select r2_selection_open from game_state where id = 1) is not true then
    raise exception 'R2_CLOSED';
  end if;

  select count(*) into v_count from team_action_cards
  where team_id = v_team_id and source = 'r2';
  if v_count >= 3 then
    raise exception 'R2_LIMIT_REACHED';
  end if;

  if exists (select 1 from team_action_cards
             where team_id = v_team_id and action_card_id = p_action_card_id and source = 'r2') then
    raise exception 'ALREADY_HAVE_CARD';
  end if;

  select category into v_category from action_cards where id = p_action_card_id;
  if exists (
    select 1 from team_action_cards tac
    join action_cards ac on ac.id = tac.action_card_id
    where tac.team_id = v_team_id and tac.source = 'r2' and ac.category = v_category
  ) then
    raise exception 'CATEGORY_ALREADY_TAKEN';
  end if;

  insert into team_action_cards (team_id, action_card_id, status, source, request_id)
  values (v_team_id, p_action_card_id, 'held', 'r2', p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function fn_r2_request_card(int, uuid) to authenticated;
revoke execute on function fn_r2_request_card(int, uuid) from anon;

create or replace function fn_play_self_card(p_team_action_card_id uuid, p_request_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id int;
  v_tac team_action_cards%rowtype;
  v_card action_cards%rowtype;
  v_team teams%rowtype;
  v_clamped record;
  v_before jsonb;
  v_after jsonb;
begin
  select au.team_id into v_team_id from fn_auth_user() au where au.app_role = 'player';
  if v_team_id is null then raise exception 'NOT_AUTHENTICATED'; end if;

  if exists (select 1 from card_plays where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if (select card_play_open from game_state where id = 1) is not true then
    raise exception 'CARD_PLAY_CLOSED';
  end if;

  select * into v_tac from team_action_cards where id = p_team_action_card_id for update;
  if v_tac.id is null or v_tac.team_id <> v_team_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_tac.status <> 'held' then raise exception 'CARD_NOT_AVAILABLE'; end if;

  select * into v_card from action_cards where id = v_tac.action_card_id;
  if v_card.category not in ('action','special') then raise exception 'WRONG_CARD_TYPE'; end if;

  select * into v_team from teams where id = v_team_id for update;
  v_before := fn_team_snapshot(v_team_id);

  v_clamped := fn_clamp_team(
    v_team.cash_l + coalesce((v_card.self_effect->>'cash_l')::int,0),
    v_team.customers + coalesce((v_card.self_effect->>'customers')::int,0),
    v_team.reputation + coalesce((v_card.self_effect->>'reputation')::int,0),
    v_team.innovation + coalesce((v_card.self_effect->>'innovation')::int,0)
  );

  if v_team.cash_l + coalesce((v_card.self_effect->>'cash_l')::int,0) < 0 then
    raise exception 'INSUFFICIENT_CASH';
  end if;

  update teams set cash_l = v_clamped.f1, customers = v_clamped.f2,
                    reputation = v_clamped.f3, innovation = v_clamped.f4
  where id = v_team_id;

  v_after := fn_team_snapshot(v_team_id);

  update team_action_cards set status = 'used', used_at = now() where id = p_team_action_card_id;

  insert into card_plays (team_action_card_id, action_card_id, team_id, status, request_id)
  values (p_team_action_card_id, v_card.id, v_team_id, 'applied', p_request_id);

  return jsonb_build_object('before', v_before, 'after', v_after);
end;
$$;

grant execute on function fn_play_self_card(uuid, uuid) to authenticated;
revoke execute on function fn_play_self_card(uuid, uuid) from anon;

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
  if not exists (select 1 from teams where id = p_partner_team_id) then
    raise exception 'PARTNER_NOT_FOUND';
  end if;

  select * into v_tac from team_action_cards where id = p_team_action_card_id for update;
  if v_tac.id is null or v_tac.team_id <> v_team_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_tac.status <> 'held' then raise exception 'CARD_NOT_AVAILABLE'; end if;

  select * into v_card from action_cards where id = v_tac.action_card_id;
  if v_card.category <> 'deal' then raise exception 'WRONG_CARD_TYPE'; end if;

  update team_action_cards set status = 'pending' where id = p_team_action_card_id;

  insert into card_plays (team_action_card_id, action_card_id, team_id, other_team_id, status, request_id)
  values (p_team_action_card_id, v_card.id, v_team_id, p_partner_team_id, 'pending', p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function fn_play_deal_card(uuid, int, uuid) to authenticated;
revoke execute on function fn_play_deal_card(uuid, int, uuid) from anon;

create or replace function fn_deals_incoming()
returns table (
  id bigint, created_at timestamptz, name text, description text, effect_text text, from_team_code text
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select cp.id, cp.created_at, ac.name, ac.description, ac.effect_text, t.team_code
  from fn_auth_user() au
  join card_plays cp on cp.other_team_id = au.team_id and cp.status = 'pending'
  join action_cards ac on ac.id = cp.action_card_id
  join teams t on t.id = cp.team_id
  where au.app_role = 'player'
  order by cp.created_at
$$;

grant execute on function fn_deals_incoming() to authenticated;
revoke execute on function fn_deals_incoming() from anon;

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

  if not p_accept then
    update card_plays set status = 'rejected' where id = p_card_play_id;
    update team_action_cards set status = 'held' where id = v_play.team_action_card_id;
    return jsonb_build_object('accepted', false);
  end if;

  if v_play.team_id < v_partner_team_id then
    select * into v_initiator from teams where id = v_play.team_id for update;
    select * into v_partner from teams where id = v_partner_team_id for update;
  else
    select * into v_partner from teams where id = v_partner_team_id for update;
    select * into v_initiator from teams where id = v_play.team_id for update;
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
revoke execute on function fn_respond_deal_card(bigint, boolean, uuid) from anon;
