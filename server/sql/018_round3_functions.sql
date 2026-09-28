-- Round 3: Crisis + Trading functions. Pairs with server/sql/016_round3_crises.sql
-- (schema) and server/sql/017_seed_crises.sql (placeholder content).
--
-- Design notes:
--  * Crisis resolution (used_card / traded / penalized) is tracked purely as
--    a status label the Super Admin sets — it never computes or applies a
--    resource change itself. The actual penalty numbers are supplied per
--    crisis by the game design and applied manually via
--    fn_admin_adjust_resources (now Super Admin only, see 014's update).
--  * Trades are the one exception to "only Super Admin changes resources":
--    an admin-processed trade can move money between the two consenting
--    teams, because that's the admin's explicit job in this workflow, not a
--    general resource edit.
--  * The trade feature toggle is per-super_admin: ON as soon as any one of
--    them enables it, OFF only once every one of them has disabled it.

-- ---------------------------------------------------------------------------
-- Visible to every team: which crises have been triggered, who they affect,
-- and which action cards protect against them.
-- ---------------------------------------------------------------------------
create or replace function fn_crisis_public()
returns table (
  crisis_id int, number smallint, title text, description text,
  affected_team_codes text[], useful_card_names text[],
  is_affected boolean, my_status text
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select c.id, c.number, c.title, c.description,
    array(select t.team_code from crisis_affected_teams cat join teams t on t.id = cat.team_id
          where cat.crisis_id = c.id order by t.team_code),
    array(select ac.name from crisis_useful_cards cuc join action_cards ac on ac.id = cuc.action_card_id
          where cuc.crisis_id = c.id order by ac.name),
    exists(select 1 from crisis_affected_teams cat where cat.crisis_id = c.id and cat.team_id = au.team_id),
    (select cat.status from crisis_affected_teams cat where cat.crisis_id = c.id and cat.team_id = au.team_id)
  from fn_require_role(array['player','admin','super_admin']) au, crises c
  where c.is_triggered
  order by c.number
$$;

grant execute on function fn_crisis_public() to authenticated;
revoke execute on function fn_crisis_public() from anon;

-- ---------------------------------------------------------------------------
-- Admin/Super Admin: full crisis list + per-crisis config/status (dashboard).
-- ---------------------------------------------------------------------------
create or replace function fn_admin_crisis_list()
returns table (id int, number smallint, title text, is_triggered boolean, triggered_at timestamptz)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select c.id, c.number, c.title, c.is_triggered, c.triggered_at
  from fn_require_role(array['admin','super_admin']) au, crises c
  order by c.number
$$;

grant execute on function fn_admin_crisis_list() to authenticated;
revoke execute on function fn_admin_crisis_list() from anon;

create or replace function fn_admin_crisis_status(p_crisis_id int)
returns table (
  team_id int, team_code text, status text, updated_at timestamptz, updated_by_login text
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select t.id, t.team_code, cat.status, cat.updated_at, u.login_id
  from fn_require_role(array['admin','super_admin']) au
  join crisis_affected_teams cat on cat.crisis_id = p_crisis_id
  join teams t on t.id = cat.team_id
  left join users u on u.id = cat.updated_by
  order by t.team_code
$$;

grant execute on function fn_admin_crisis_status(int) to authenticated;
revoke execute on function fn_admin_crisis_status(int) from anon;

create or replace function fn_admin_crisis_useful_cards(p_crisis_id int)
returns table (action_card_id int, name text, category text)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select ac.id, ac.name, ac.category
  from fn_require_role(array['admin','super_admin']) au
  join crisis_useful_cards cuc on cuc.crisis_id = p_crisis_id
  join action_cards ac on ac.id = cuc.action_card_id
  order by ac.name
$$;

grant execute on function fn_admin_crisis_useful_cards(int) to authenticated;
revoke execute on function fn_admin_crisis_useful_cards(int) from anon;

-- ---------------------------------------------------------------------------
-- Super Admin: trigger next crisis, configure useful cards / affected teams,
-- and set a team's per-crisis status (the dropdown, including "Use action
-- card" which is a no-op on resources).
-- ---------------------------------------------------------------------------
create or replace function fn_super_trigger_crisis()
returns crises
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_row crises%rowtype;
begin
  select user_id into v_actor from fn_require_role(array['super_admin']);

  select * into v_row from crises where not is_triggered order by number limit 1;
  if v_row.id is null then raise exception 'NO_MORE_CRISES'; end if;

  update crises set is_triggered = true, triggered_at = now(), triggered_by = v_actor
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function fn_super_trigger_crisis() to authenticated;
revoke execute on function fn_super_trigger_crisis() from anon;

create or replace function fn_super_set_crisis_useful_cards(p_crisis_id int, p_action_card_ids int[])
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from fn_require_role(array['super_admin']);
  if not exists (select 1 from crises where id = p_crisis_id) then raise exception 'CRISIS_NOT_FOUND'; end if;

  delete from crisis_useful_cards where crisis_id = p_crisis_id;
  insert into crisis_useful_cards (crisis_id, action_card_id)
  select p_crisis_id, id from unnest(p_action_card_ids) as id;
end;
$$;

grant execute on function fn_super_set_crisis_useful_cards(int, int[]) to authenticated;
revoke execute on function fn_super_set_crisis_useful_cards(int, int[]) from anon;

create or replace function fn_super_set_crisis_affected_teams(p_crisis_id int, p_team_ids int[])
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from fn_require_role(array['super_admin']);
  if not exists (select 1 from crises where id = p_crisis_id) then raise exception 'CRISIS_NOT_FOUND'; end if;

  delete from crisis_affected_teams where crisis_id = p_crisis_id and team_id <> all(p_team_ids);
  insert into crisis_affected_teams (crisis_id, team_id)
  select p_crisis_id, id from unnest(p_team_ids) as id
  on conflict (crisis_id, team_id) do nothing;
end;
$$;

grant execute on function fn_super_set_crisis_affected_teams(int, int[]) to authenticated;
revoke execute on function fn_super_set_crisis_affected_teams(int, int[]) from anon;

-- Placeholder-content convenience: randomly pick p_count active teams as
-- affected, for testing before the real affected-team lists are supplied.
create or replace function fn_super_randomize_crisis_teams(p_crisis_id int, p_count int default 2)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ids int[];
begin
  perform 1 from fn_require_role(array['super_admin']);
  if not exists (select 1 from crises where id = p_crisis_id) then raise exception 'CRISIS_NOT_FOUND'; end if;

  select array_agg(id) into v_ids from (
    select id from teams where is_active order by random() limit greatest(p_count, 0)
  ) s;

  delete from crisis_affected_teams where crisis_id = p_crisis_id;
  insert into crisis_affected_teams (crisis_id, team_id)
  select p_crisis_id, id from unnest(coalesce(v_ids, array[]::int[])) as id;
end;
$$;

grant execute on function fn_super_randomize_crisis_teams(int, int) to authenticated;
revoke execute on function fn_super_randomize_crisis_teams(int, int) from anon;

create or replace function fn_super_set_crisis_team_status(p_crisis_id int, p_team_id int, p_status text)
returns crisis_affected_teams
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_row crisis_affected_teams%rowtype;
begin
  select user_id into v_actor from fn_require_role(array['super_admin']);
  if p_status not in ('pending','used_card','traded','penalized') then raise exception 'BAD_STATUS'; end if;

  update crisis_affected_teams
  set status = p_status, updated_at = now(), updated_by = v_actor
  where crisis_id = p_crisis_id and team_id = p_team_id
  returning * into v_row;

  if v_row.id is null then raise exception 'TEAM_NOT_AFFECTED'; end if;
  return v_row;
end;
$$;

grant execute on function fn_super_set_crisis_team_status(int, int, text) to authenticated;
revoke execute on function fn_super_set_crisis_team_status(int, int, text) from anon;

-- ---------------------------------------------------------------------------
-- Trade feature toggle: per-super_admin row; effective state is ON if ANY
-- row is enabled, OFF only once every row is disabled.
-- ---------------------------------------------------------------------------
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
    exists(select 1 from trade_feature_toggles tft where tft.enabled),
    case when v_au.app_role = 'super_admin'
      then coalesce((select tft.enabled from trade_feature_toggles tft where tft.super_admin_id = v_au.user_id), false)
      else null end;
end;
$$;

grant execute on function fn_trade_feature_status() to authenticated;
revoke execute on function fn_trade_feature_status() from anon;

create or replace function fn_super_trade_toggle_set(p_enabled boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
begin
  select user_id into v_actor from fn_require_role(array['super_admin']);
  insert into trade_feature_toggles (super_admin_id, enabled, updated_at)
  values (v_actor, p_enabled, now())
  on conflict (super_admin_id) do update set enabled = excluded.enabled, updated_at = now();
end;
$$;

grant execute on function fn_super_trade_toggle_set(boolean) to authenticated;
revoke execute on function fn_super_trade_toggle_set(boolean) from anon;

-- Transparency view for the Control Room: which super admins currently have
-- trading turned on (so "who do I still need to convince" is visible).
create or replace function fn_super_trade_toggles_all()
returns table (super_admin_login text, enabled boolean)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select u.login_id, coalesce(tft.enabled, false)
  from fn_require_role(array['super_admin']) au
  join users u on u.role = 'super_admin' and u.is_active
  left join trade_feature_toggles tft on tft.super_admin_id = u.id
  order by u.login_id
$$;

grant execute on function fn_super_trade_toggles_all() to authenticated;
revoke execute on function fn_super_trade_toggles_all() from anon;

-- ---------------------------------------------------------------------------
-- Admin/Super Admin: process a trade the two teams already agreed to
-- off-app. Swaps the two held action cards between the teams, optionally
-- moves money from one side to the other, and (if tied to a crisis) marks a
-- team 'traded' when the card they end up with protects them against it.
-- ---------------------------------------------------------------------------
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
  v_payee_id int;
begin
  select user_id into v_actor from fn_require_role(array['admin','super_admin']);

  if exists (select 1 from trades where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if not exists (select 1 from trade_feature_toggles where enabled) then
    raise exception 'TRADING_DISABLED';
  end if;
  if p_team_a_id = p_team_b_id then raise exception 'CANNOT_TRADE_SELF'; end if;
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

  if coalesce(p_money_amount, 0) > 0 then
    -- lock both team rows in a fixed order to avoid deadlocking against a
    -- concurrent trade/adjustment touching the same two teams
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
revoke execute on function fn_admin_process_trade(int, uuid, int, uuid, int, int, int, uuid) from anon;
