-- Fourth Supabase-direct slice: admin + super admin + Market Mayhem.
--
-- Unlike the player-side functions, admin actions legitimately target an
-- arbitrary OTHER team (p_team_id stays an explicit parameter) — what needs
-- to come from fn_auth_user() here is the caller's ROLE, checked inside each
-- function body (fn_require_role), not a team id to derive.
--
-- fn_admin_adjust_resources/fn_admin_adjust_decision_points already exist
-- with signatures Express still calls untouched; since both already take
-- only the minimal params (nothing left to drop to form a natural
-- overload), the new caller-authenticated versions take their deltas as a
-- single jsonb payload instead, which is both a legitimate distinct
-- signature and a more idiomatic single-object RPC call from JS.
-- fn_trigger_mayhem_event and fn_record_mayhem_response DO have an actor/
-- event id to naturally drop, same as fn_replace_identity_card, so those
-- keep the established "same name, fewer args" overload pattern.

create or replace function fn_require_role(p_roles text[])
returns table (user_id uuid, app_role text, team_id int)
language plpgsql security definer stable
set search_path = public, pg_temp
as $$
declare
  v_au record;
begin
  select * into v_au from fn_auth_user() au;
  if v_au.user_id is null or not (v_au.app_role = any(p_roles)) then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  return query select v_au.user_id, v_au.app_role, v_au.team_id;
end;
$$;

grant execute on function fn_require_role(text[]) to authenticated;
revoke execute on function fn_require_role(text[]) from anon;

-- ---------------------------------------------------------------------------
-- Admin + Super Admin: team list / per-team hand / resource + points adjust
-- ---------------------------------------------------------------------------
create or replace function fn_admin_teams()
returns table (
  id int, team_code text, cash_l int, customers int, reputation smallint, innovation smallint,
  replacements_used smallint, mission_completed boolean, market_title text, customer_title text
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select t.id, t.team_code, t.cash_l, t.customers, t.reputation, t.innovation,
         t.replacements_used, t.mission_completed, mk.title, cu.title
  from fn_require_role(array['admin','super_admin']) au
  join teams t on t.is_active
  join identity_cards mk on mk.id = t.market_card_id
  join identity_cards cu on cu.id = t.customer_card_id
  order by t.team_code
$$;

grant execute on function fn_admin_teams() to authenticated;
revoke execute on function fn_admin_teams() from anon;

create or replace function fn_admin_team_cards(p_team_id int)
returns table (id uuid, status text, category text, name text, description text, effect_text text)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select tac.id, tac.status, ac.category, ac.name, ac.description, ac.effect_text
  from fn_require_role(array['admin','super_admin']) au
  join team_action_cards tac on tac.team_id = p_team_id
  join action_cards ac on ac.id = tac.action_card_id
  order by tac.acquired_at
$$;

grant execute on function fn_admin_team_cards(int) to authenticated;
revoke execute on function fn_admin_team_cards(int) from anon;

create or replace function fn_admin_adjust_resources(p_team_id int, p_delta jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team teams%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_c record;
begin
  perform 1 from fn_require_role(array['admin','super_admin']);

  select * into v_team from teams where id = p_team_id for update;
  if v_team.id is null then raise exception 'TEAM_NOT_FOUND'; end if;
  v_before := fn_team_snapshot(p_team_id);

  v_c := fn_clamp_team(
    v_team.cash_l + coalesce((p_delta->>'cash_l')::int, 0),
    v_team.customers + coalesce((p_delta->>'customers')::int, 0),
    v_team.reputation + coalesce((p_delta->>'reputation')::int, 0),
    v_team.innovation + coalesce((p_delta->>'innovation')::int, 0));

  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = p_team_id;

  v_after := fn_team_snapshot(p_team_id);
  return jsonb_build_object('before', v_before, 'after', v_after);
end;
$$;

grant execute on function fn_admin_adjust_resources(int, jsonb) to authenticated;
revoke execute on function fn_admin_adjust_resources(int, jsonb) from anon;

create or replace function fn_admin_adjust_decision_points(p_team_id int, p_payload jsonb)
returns teams
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_row teams%rowtype;
begin
  perform 1 from fn_require_role(array['admin','super_admin']);

  update teams set decision_points = decision_points + coalesce((p_payload->>'delta')::int, 0)
  where id = p_team_id
  returning * into v_row;
  if v_row.id is null then raise exception 'TEAM_NOT_FOUND'; end if;
  return v_row;
end;
$$;

grant execute on function fn_admin_adjust_decision_points(int, jsonb) to authenticated;
revoke execute on function fn_admin_adjust_decision_points(int, jsonb) from anon;

-- ---------------------------------------------------------------------------
-- Super Admin only: toggles, team management, decision points, leaderboard
-- ---------------------------------------------------------------------------
create or replace function fn_super_toggles_get()
returns game_state
language plpgsql security definer stable
set search_path = public, pg_temp
as $$
declare
  v_row game_state%rowtype;
begin
  perform 1 from fn_require_role(array['super_admin']);
  select * into v_row from game_state where id = 1;
  return v_row;
end;
$$;

grant execute on function fn_super_toggles_get() to authenticated;
revoke execute on function fn_super_toggles_get() from anon;

create or replace function fn_super_toggles_set(p_key text, p_value boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from fn_require_role(array['super_admin']);
  if p_key not in ('r1_replace_open', 'r2_selection_open', 'card_play_open') then
    raise exception 'BAD_TOGGLE_KEY';
  end if;
  execute format('update game_state set %I = $1, updated_at = now() where id = 1', p_key) using p_value;
end;
$$;

grant execute on function fn_super_toggles_set(text, boolean) to authenticated;
revoke execute on function fn_super_toggles_set(text, boolean) from anon;

-- Same random-password shape as the old Express randomPassword(): 8 chars
-- from an alphabet with visually-ambiguous characters removed.
create or replace function fn_random_password() returns text
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  v_bytes bytea := gen_random_bytes(8);
  v_out text := '';
  i int;
begin
  for i in 0..7 loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
  end loop;
  return v_out;
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

  return jsonb_build_object('teamId', v_team_id, 'teamCode', p_team_code, 'password', v_password);
end;
$$;

grant execute on function fn_super_add_team(text) to authenticated;
revoke execute on function fn_super_add_team(text) from anon;

create or replace function fn_super_deactivate_team(p_team_id int)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from fn_require_role(array['super_admin']);
  update teams set is_active = false where id = p_team_id;
  update users set is_active = false where team_id = p_team_id;
end;
$$;

grant execute on function fn_super_deactivate_team(int) to authenticated;
revoke execute on function fn_super_deactivate_team(int) from anon;

create or replace function fn_super_reset_password(p_user_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_password text;
  v_login_id text;
  v_role text;
begin
  perform 1 from fn_require_role(array['super_admin']);

  v_password := fn_random_password();
  update users set password_hash = crypt(v_password, gen_salt('bf')), session_version = session_version + 1
  where id = p_user_id
  returning login_id, role into v_login_id, v_role;

  if v_login_id is null then raise exception 'USER_NOT_FOUND'; end if;
  return jsonb_build_object('loginId', v_login_id, 'role', v_role, 'password', v_password);
end;
$$;

grant execute on function fn_super_reset_password(uuid) to authenticated;
revoke execute on function fn_super_reset_password(uuid) from anon;

create or replace function fn_super_decision_points()
returns table (team_id int, team_code text, decision_points int)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select t.id, t.team_code, t.decision_points
  from fn_require_role(array['super_admin']) au, teams t
  order by t.team_code
$$;

grant execute on function fn_super_decision_points() to authenticated;
revoke execute on function fn_super_decision_points() from anon;

-- Raw per-team data for the leaderboard; the Resource/Decision/Mission
-- scoring formula is pure display math with no security stakes, so it's
-- computed client-side (ScoresTab.jsx) from this instead of duplicated here.
create or replace function fn_super_leaderboard_raw()
returns table (
  team_id int, team_code text, cash_l int, customers int, reputation smallint, innovation smallint,
  mission_completed boolean, decision_points int, bonus_points smallint
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select t.id, t.team_code, t.cash_l, t.customers, t.reputation, t.innovation,
         t.mission_completed, t.decision_points, mc.bonus_points
  from fn_require_role(array['super_admin']) au
  join teams t on t.is_active
  left join identity_cards mc on mc.id = t.mission_card_id
  order by t.team_code
$$;

grant execute on function fn_super_leaderboard_raw() to authenticated;
revoke execute on function fn_super_leaderboard_raw() from anon;

create or replace function fn_super_mark_mission(p_team_id int, p_completed boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from fn_require_role(array['super_admin']);
  update teams set mission_completed = p_completed where id = p_team_id;
end;
$$;

grant execute on function fn_super_mark_mission(int, boolean) to authenticated;
revoke execute on function fn_super_mark_mission(int, boolean) from anon;

-- ---------------------------------------------------------------------------
-- Market Mayhem (Round 3): admin/super_admin read + record, super_admin-only
-- trigger. fn_trigger_mayhem_event/fn_record_mayhem_response already exist
-- with an explicit actor/event id Express passes in — these new overloads
-- derive both from fn_auth_user(), same pattern as fn_replace_identity_card.
-- ---------------------------------------------------------------------------
create or replace function fn_mayhem_current()
returns table (
  mayhem_event_id int, number smallint, triggered_at timestamptz,
  title text, story_text text, effect_text text, tags text[]
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select e.id, e.number, e.triggered_at, e.title, e.story_text, e.effect_text, e.tags
  from fn_require_role(array['admin','super_admin']) au
  join game_state gs on gs.id = 1
  join mayhem_events e on e.id = gs.current_mayhem_event_id
$$;

grant execute on function fn_mayhem_current() to authenticated;
revoke execute on function fn_mayhem_current() from anon;

create or replace function fn_mayhem_events()
returns table (id int, number smallint, title text, is_triggered boolean, triggered_at timestamptz)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select e.id, e.number, e.title, e.is_triggered, e.triggered_at
  from fn_require_role(array['admin','super_admin']) au, mayhem_events e
  order by e.number
$$;

grant execute on function fn_mayhem_events() to authenticated;
revoke execute on function fn_mayhem_events() from anon;

create or replace function fn_trigger_mayhem_event()
returns mayhem_events
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_row mayhem_events%rowtype;
begin
  select user_id into v_actor from fn_require_role(array['super_admin']);

  select * into v_row from mayhem_events where not is_triggered order by number limit 1;
  if v_row.id is null then raise exception 'NO_MORE_EVENTS'; end if;

  update mayhem_events set is_triggered = true, triggered_at = now(), triggered_by = v_actor
  where id = v_row.id
  returning * into v_row;

  update game_state set current_mayhem_event_id = v_row.id, updated_at = now() where id = 1;

  return v_row;
end;
$$;

grant execute on function fn_trigger_mayhem_event() to authenticated;
revoke execute on function fn_trigger_mayhem_event() from anon;

create or replace function fn_mayhem_team_status()
returns table (
  team_id int, team_code text, market_title text, tier text,
  response text, partner_team_id int, applied jsonb, partner_team_code text
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select t.id, t.team_code, mk.title, mt.tier,
         r.response, r.partner_team_id, r.applied, pt.team_code
  from fn_require_role(array['admin','super_admin']) au
  join game_state gs on gs.id = 1
  join teams t on t.is_active
  join identity_cards mk on mk.id = t.market_card_id
  left join market_tiers mt on mt.mayhem_event_id = gs.current_mayhem_event_id and mt.market_card_id = t.market_card_id
  left join team_mayhem_responses r on r.mayhem_event_id = gs.current_mayhem_event_id and r.team_id = t.id
  left join teams pt on pt.id = r.partner_team_id
  where gs.current_mayhem_event_id is not null
  order by case mt.tier
             when 'hit_hard' then 0
             when 'hit' then 1
             when 'unaffected' then 2
             when 'gains' then 3
             else 4
           end,
           t.team_code
$$;

grant execute on function fn_mayhem_team_status() to authenticated;
revoke execute on function fn_mayhem_team_status() from anon;

create or replace function fn_record_mayhem_response(
  p_team_id int, p_response text, p_partner_team_id int, p_request_id uuid
) returns team_mayhem_responses
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_event_id int;
  v_event mayhem_events%rowtype;
  v_team teams%rowtype;
  v_partner teams%rowtype;
  v_tier text;
  v_next_tier text;
  v_d_cash int := 0;
  v_d_customers int := 0;
  v_d_reputation int := 0;
  v_d_innovation int := 0;
  v_partner_d_customers int := 0;
  v_c record;
  v_row team_mayhem_responses%rowtype;
begin
  select user_id into v_actor from fn_require_role(array['admin','super_admin']);

  select current_mayhem_event_id into v_event_id from game_state where id = 1;
  if v_event_id is null then raise exception 'EVENT_NOT_FOUND'; end if;

  if p_response not in ('accept', 'spend', 'adapt', 'partner') then raise exception 'BAD_RESPONSE'; end if;

  select * into v_event from mayhem_events where id = v_event_id;
  if v_event.id is null then raise exception 'EVENT_NOT_FOUND'; end if;

  select * into v_team from teams where id = p_team_id for update;
  if v_team.id is null then raise exception 'TEAM_NOT_FOUND'; end if;

  select tier into v_tier from market_tiers
  where mayhem_event_id = v_event_id and market_card_id = v_team.market_card_id;
  if v_tier is null then raise exception 'TIER_NOT_FOUND'; end if;

  v_next_tier := case v_tier when 'hit_hard' then 'hit' when 'hit' then 'unaffected' else v_tier end;

  if p_response = 'accept' then
    if v_tier in ('hit_hard', 'hit') then
      v_d_cash := coalesce((v_event.tier_deltas->v_tier->>'cash_l')::int, 0);
      v_d_customers := coalesce((v_event.tier_deltas->v_tier->>'customers')::int, 0);
      v_d_reputation := coalesce((v_event.tier_deltas->v_tier->>'reputation')::int, 0);
      v_d_innovation := coalesce((v_event.tier_deltas->v_tier->>'innovation')::int, 0);
    else
      v_d_innovation := 1;
    end if;

  elsif p_response = 'spend' then
    v_d_cash := -10;
    if v_tier in ('unaffected', 'gains') then
      v_d_customers := 40000;
    end if;

  elsif p_response = 'adapt' then
    v_d_innovation := -2;
    if v_tier in ('hit_hard', 'hit') then
      v_d_cash := v_d_cash + coalesce((v_event.tier_deltas->v_next_tier->>'cash_l')::int, 0);
      v_d_customers := v_d_customers + coalesce((v_event.tier_deltas->v_next_tier->>'customers')::int, 0) + 20000;
      v_d_reputation := v_d_reputation + coalesce((v_event.tier_deltas->v_next_tier->>'reputation')::int, 0);
      v_d_innovation := v_d_innovation + coalesce((v_event.tier_deltas->v_next_tier->>'innovation')::int, 0);
    else
      v_d_customers := 40000;
    end if;

  elsif p_response = 'partner' then
    if v_tier in ('hit_hard', 'hit') then
      if p_partner_team_id is null or p_partner_team_id = p_team_id then raise exception 'PARTNER_REQUIRED'; end if;
      v_d_cash := coalesce((v_event.tier_deltas->v_next_tier->>'cash_l')::int, 0);
      v_d_customers := coalesce((v_event.tier_deltas->v_next_tier->>'customers')::int, 0);
      v_d_reputation := coalesce((v_event.tier_deltas->v_next_tier->>'reputation')::int, 0);
      v_d_innovation := coalesce((v_event.tier_deltas->v_next_tier->>'innovation')::int, 0);
      v_partner_d_customers := 20000;
    else
      v_d_customers := 20000;
    end if;
  end if;

  v_c := fn_clamp_team_mayhem(
    v_team.cash_l + v_d_cash, v_team.customers + v_d_customers,
    v_team.reputation + v_d_reputation, v_team.innovation + v_d_innovation);
  update teams set cash_l = v_c.f1, customers = v_c.f2, reputation = v_c.f3, innovation = v_c.f4
  where id = p_team_id;

  if p_response = 'partner' and v_tier in ('hit_hard', 'hit') then
    select * into v_partner from teams where id = p_partner_team_id for update;
    if v_partner.id is null then raise exception 'PARTNER_NOT_FOUND'; end if;
    v_c := fn_clamp_team_mayhem(v_partner.cash_l, v_partner.customers + v_partner_d_customers, v_partner.reputation, v_partner.innovation);
    update teams set customers = v_c.f2 where id = p_partner_team_id;
  end if;

  insert into team_mayhem_responses (mayhem_event_id, team_id, tier, response, partner_team_id, applied, recorded_by, request_id)
  values (v_event_id, p_team_id, v_tier, p_response,
          case when p_response = 'partner' and v_tier in ('hit_hard','hit') then p_partner_team_id else null end,
          jsonb_build_object('cash_l', v_d_cash, 'customers', v_d_customers, 'reputation', v_d_reputation, 'innovation', v_d_innovation),
          v_actor, p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function fn_record_mayhem_response(int, text, int, uuid) to authenticated;
revoke execute on function fn_record_mayhem_response(int, text, int, uuid) from anon;
