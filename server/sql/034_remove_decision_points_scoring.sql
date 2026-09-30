-- Removes Decision Points from scoring entirely:
--  1. Triggering a crisis no longer touches decision_points at all — only
--     cash/customers/reputation/innovation, per the crisis's tier.
--  2. The teams.decision_points column and fn_admin_adjust_decision_points
--     RPC are left in place (dropping a column is unnecessary risk for
--     something that's simply going unused now, and the column stays
--     harmless dead data), but the client no longer reads, displays, or
--     scores with it at all — see the matching client changes removing
--     the Manage Teams "Decision Points" button and the Leaderboard's
--     "Raw Points"/"Decision" columns.
--
-- New leaderboard formula: Total = Resource Score (100%) + Mission Bonus.
-- (was: 30% Resource + 70% Decision Score (clamped 0-100) + Mission Bonus)

create or replace function fn_super_trigger_crisis(p_crisis_id int)
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

    -- decision_points is deliberately NOT touched here any more
    update teams set
      cash_l = v_c.f1, customers = v_c.f2, reputation = v_c.f3, innovation = v_c.f4
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

-- Excel emergency fallback (033) mirrors the same logic — keep it in sync.
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
      cash_l = v_c.f1, customers = v_c.f2, reputation = v_c.f3, innovation = v_c.f4
    where id = v_team.id;

    insert into crisis_team_effects (crisis_id, team_id, tier, applied)
    values (v_row.id, v_team.id, v_tier, v_delta)
    on conflict (crisis_id, team_id) do update set tier = excluded.tier, applied = excluded.applied;

    v_count := v_count + 1;
  end loop;

  return query select v_row.number, v_row.title, v_count;
end;
$$;

grant execute on function fn_excel_trigger_next_crisis() to excel_writer;

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on function fn_login(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
