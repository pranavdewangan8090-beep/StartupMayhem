-- Emergency write-back from Excel (or any Postgres client), for when the
-- site itself is down and a Super Admin still needs to run the event.
--
-- A SEPARATE role from 032's excel_reporting — read-only monitoring and
-- emergency control are different privilege levels, and should be handed
-- to different people / a different password. excel_writer can also read
-- the same 5 reporting views (one workbook can do both), but its write
-- power is limited to a curated set of fn_excel_* functions below — never
-- raw table access. Each function is a thin, team-code-addressed wrapper
-- around the EXACT SAME validated logic the real app RPCs use (clamps via
-- fn_clamp_team, row locks, cascading effects like withdrawing pending
-- deals on deactivation) — a raw `UPDATE teams SET ...` from Excel would
-- skip all of that and risk corrupting data, which is exactly what this
-- avoids.
--
-- There's no JWT/login here (Excel connects over the native Postgres
-- protocol, not through fn_login), so these functions don't check a
-- caller's role the way fn_require_role() does — the ONLY gate is holding
-- excel_writer's password, via Postgres's own GRANT EXECUTE. Treat that
-- password as equivalent to full Super Admin access, and only hand it to
-- actual Super Admins.
--
-- SECURITY: same convention as excel_reporting/_app_secrets — the role is
-- created with a random, immediately-discarded placeholder password. Set
-- the real one yourself right after applying this file:
--   node scripts/applySql.js --commit sql/033_excel_write_access.sql
--   (then run an uncommitted ALTER ROLE ... WITH PASSWORD '...' directly)

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'excel_writer') then
    execute format('create role excel_writer login password %L', gen_random_uuid()::text);
  end if;
end $$;

grant usage on schema public to excel_writer;
grant select on v_excel_leaderboard, v_excel_teams, v_excel_hands, v_excel_crises, v_excel_accounts
  to excel_writer;

-- ---------------------------------------------------------------------------
-- Resolve a team by its display code (T01, T45, ...) with a row lock —
-- Excel users think in team codes, not internal ids.
-- ---------------------------------------------------------------------------
create or replace function fn_excel_resolve_team(p_team_code text)
returns int
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id int;
begin
  select id into v_id from teams where team_code = p_team_code for update;
  if v_id is null then raise exception 'TEAM_NOT_FOUND: %', p_team_code; end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Adjust a team's resources — same clamp behavior as fn_admin_adjust_resources.
-- ---------------------------------------------------------------------------
create or replace function fn_excel_adjust_resources(
  p_team_code text, p_d_cash_l int default 0, p_d_customers int default 0,
  p_d_reputation int default 0, p_d_innovation int default 0
) returns table (team_code text, cash_l int, customers int, reputation smallint, innovation smallint)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id int := fn_excel_resolve_team(p_team_code);
  v_team teams%rowtype;
  v_c record;
begin
  select * into v_team from teams where id = v_team_id;
  v_c := fn_clamp_team(
    v_team.cash_l + p_d_cash_l, v_team.customers + p_d_customers,
    v_team.reputation + p_d_reputation, v_team.innovation + p_d_innovation);
  update teams set cash_l = v_c.f1, customers = v_c.f2, reputation = v_c.f3, innovation = v_c.f4
  where id = v_team_id;
  return query select t.team_code, t.cash_l, t.customers, t.reputation, t.innovation from teams t where t.id = v_team_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Adjust decision points — same as fn_admin_adjust_decision_points.
-- ---------------------------------------------------------------------------
create or replace function fn_excel_adjust_decision_points(p_team_code text, p_delta int)
returns table (team_code text, decision_points int)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id int := fn_excel_resolve_team(p_team_code);
begin
  -- qualified as teams.decision_points: the RETURNS TABLE column of the
  -- same name is in scope here too, and an unqualified reference is
  -- ambiguous between "the OUT parameter" and "the table column"
  update teams set decision_points = teams.decision_points + p_delta where id = v_team_id;
  return query select t.team_code, t.decision_points from teams t where t.id = v_team_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Mark a team's Secret Mission complete/incomplete.
-- ---------------------------------------------------------------------------
create or replace function fn_excel_mark_mission(p_team_code text, p_completed boolean)
returns table (team_code text, mission_completed boolean)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id int := fn_excel_resolve_team(p_team_code);
begin
  update teams set mission_completed = p_completed where id = v_team_id;
  return query select t.team_code, t.mission_completed from teams t where t.id = v_team_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Flip a game_state toggle — same whitelist as fn_super_toggles_set.
-- ---------------------------------------------------------------------------
create or replace function fn_excel_set_toggle(p_key text, p_value boolean)
returns table (r1_replace_open boolean, card_play_open boolean)
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_key not in ('r1_replace_open', 'card_play_open') then
    raise exception 'BAD_TOGGLE_KEY: %', p_key;
  end if;
  execute format('update game_state set %I = $1, updated_at = now() where id = 1', p_key) using p_value;
  return query select gs.r1_replace_open, gs.card_play_open from game_state gs where gs.id = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Deactivate / reactivate a team — same effects as fn_super_deactivate_team
-- / fn_super_reactivate_team, including withdrawing that team's pending
-- deals and (since 031) freeing its cards back to the 3-copy pool.
-- ---------------------------------------------------------------------------
create or replace function fn_excel_deactivate_team(p_team_code text)
returns table (team_code text, is_active boolean)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id int := fn_excel_resolve_team(p_team_code);
begin
  update teams set is_active = false where id = v_team_id;
  update users set is_active = false where team_id = v_team_id;

  update team_action_cards set status = 'held'
  where id in (select team_action_card_id from card_plays
               where status = 'pending' and (team_id = v_team_id or other_team_id = v_team_id));
  update card_plays set status = 'cancelled'
  where status = 'pending' and (team_id = v_team_id or other_team_id = v_team_id);

  return query select t.team_code, t.is_active from teams t where t.id = v_team_id;
end;
$$;

create or replace function fn_excel_reactivate_team(p_team_code text)
returns table (team_code text, is_active boolean)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id int := fn_excel_resolve_team(p_team_code);
begin
  update teams set is_active = true where id = v_team_id;
  update users set is_active = true where team_id = v_team_id;
  return query select t.team_code, t.is_active from teams t where t.id = v_team_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trigger the next crisis in sequence — same logic as fn_super_trigger_crisis
-- (serialized via a lock on game_state, applies the tier-based effect to
-- every active team in one go), just without the JWT-based actor.
-- ---------------------------------------------------------------------------
create or replace function fn_excel_trigger_next_crisis()
returns table (number smallint, title text, teams_affected bigint)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_row crises%rowtype;
  v_team record;
  v_tier text;
  v_delta jsonb;
  v_c record;
  v_count bigint := 0;
begin
  perform 1 from game_state where id = 1 for update;

  select * into v_row from crises where not is_triggered order by number limit 1;
  if v_row.id is null then raise exception 'NO_MORE_CRISES'; end if;

  update crises set is_triggered = true, triggered_at = now(), triggered_by = null
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

    v_count := v_count + 1;
  end loop;

  return query select v_row.number, v_row.title, v_count;
end;
$$;

grant execute on function
  fn_excel_adjust_resources(text, int, int, int, int),
  fn_excel_adjust_decision_points(text, int),
  fn_excel_mark_mission(text, boolean),
  fn_excel_set_toggle(text, boolean),
  fn_excel_deactivate_team(text),
  fn_excel_reactivate_team(text),
  fn_excel_trigger_next_crisis()
to excel_writer;

-- fn_excel_resolve_team is an internal helper only — no grant, matches the
-- app's fn_clamp_team/fn_team_snapshot pattern.

-- Belt and braces, same pattern as 032: confirm excel_writer can reach no
-- raw table at all, only what's explicitly granted above.
revoke all on all tables in schema public from excel_writer;
grant select on v_excel_leaderboard, v_excel_teams, v_excel_hands, v_excel_crises, v_excel_accounts
  to excel_writer;

-- Re-assert the main app's lockdown too, since this file touches the
-- schema-wide PUBLIC/anon revoke pattern's neighborhood.
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on function fn_login(text, text, text) to anon, authenticated;
grant execute on function
  fn_excel_adjust_resources(text, int, int, int, int),
  fn_excel_adjust_decision_points(text, int),
  fn_excel_mark_mission(text, boolean),
  fn_excel_set_toggle(text, boolean),
  fn_excel_deactivate_team(text),
  fn_excel_reactivate_team(text),
  fn_excel_trigger_next_crisis()
to excel_writer;

notify pgrst, 'reload schema';
