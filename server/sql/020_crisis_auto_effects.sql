-- Round 3 redesign: crisis resolution is now fully automatic, driven by
-- each team's Market identity card — not a manually-picked affected-team
-- list resolved by hand. This restores the old Market Mayhem model (a
-- per-crisis tier-to-delta table, computed and applied the instant the
-- crisis triggers) but keeps the "crisis" framing/schema from 016-018.
--
-- Card-based protection (crisis_useful_cards / crisis_affected_teams /
-- fn_super_set_crisis_team_status etc.) is intentionally left in place but
-- UNUSED by the client for now — the plan is to reintroduce it later as a
-- way to soften a bad tier, not to gate it entirely. Nothing here drops
-- those tables/functions.

-- Which tier a team lands in for a crisis, keyed by their Market card —
-- predetermined by the game design, not per-team.
create table if not exists crisis_market_tiers (
  crisis_id       int not null references crises(id) on delete cascade,
  market_card_id  int not null references identity_cards(id),
  tier            text not null check (tier in ('hit_hard', 'hit', 'unaffected', 'gains')),
  primary key (crisis_id, market_card_id)
);

-- Per-crisis, per-tier resource delta, e.g.
-- {"hit_hard": {"cash_l": -20, "innovation": -2, "decision_points": -40}, ...}.
-- cash_l is in lakhs (10 = ₹1M), same unit as everywhere else. decision_points
-- is the hidden score-only field (see teams.decision_points) — the constant
-- ±40/±20/0/+20 per tier the design gives alongside every crisis's resource
-- numbers reads as a severity score for that 70%-weighted leaderboard input,
-- so it's applied here too; flag if that reading's wrong.
alter table crises add column if not exists tier_deltas jsonb not null default '{}'::jsonb;

-- One row per (crisis, team): the tier they landed in and the exact delta
-- applied, written automatically by fn_super_trigger_crisis — never edited
-- by hand. This is what the player dashboard and admin crisis view read.
create table if not exists crisis_team_effects (
  id          bigserial primary key,
  crisis_id   int not null references crises(id) on delete cascade,
  team_id     int not null references teams(id) on delete cascade,
  tier        text not null check (tier in ('hit_hard', 'hit', 'unaffected', 'gains')),
  applied     jsonb not null,
  created_at  timestamptz not null default now(),
  unique (crisis_id, team_id)
);

do $$
declare t text;
begin
  for t in select unnest(array['crisis_market_tiers', 'crisis_team_effects']) loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Trigger the next crisis AND apply its effect to every active team in the
-- same transaction — this is the "staged automatically ... deducted
-- automatically" behavior. Tier comes from the team's Market card; a card
-- with no row in crisis_market_tiers for this crisis defaults to
-- 'unaffected' (shouldn't happen once every crisis covers all 20 cards, but
-- a defined fallback beats a crash).
-- ---------------------------------------------------------------------------
create or replace function fn_super_trigger_crisis()
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

  select * into v_row from crises where not is_triggered order by number limit 1;
  if v_row.id is null then raise exception 'NO_MORE_CRISES'; end if;

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

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Player/admin/super_admin: triggered crises with the caller's own team's
-- tier + applied effect (null for admin/super_admin, who have no team).
-- ---------------------------------------------------------------------------
-- decision_points is stripped from `applied` here (unlike
-- fn_admin_crisis_effects) — it's a hidden, super-admin-only scoring field
-- everywhere else in the app (see teams.decision_points), so this is the one
-- place it could otherwise leak to a player's network tab.
drop function if exists fn_crisis_public();
create function fn_crisis_public()
returns table (crisis_id int, number smallint, title text, description text, tier text, applied jsonb)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select c.id, c.number, c.title, c.description, cte.tier, cte.applied - 'decision_points'
  from fn_require_role(array['player','admin','super_admin']) au
  join crises c on c.is_triggered
  left join crisis_team_effects cte on cte.crisis_id = c.id and cte.team_id = au.team_id
  order by c.number
$$;

grant execute on function fn_crisis_public() to authenticated;
revoke execute on function fn_crisis_public() from anon;

-- fn_admin_crisis_list gains `description` — the Control Room's crisis
-- detail panel shows the real story text now, not a generic fallback.
drop function if exists fn_admin_crisis_list();
create function fn_admin_crisis_list()
returns table (id int, number smallint, title text, description text, is_triggered boolean, triggered_at timestamptz)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select c.id, c.number, c.title, c.description, c.is_triggered, c.triggered_at
  from fn_require_role(array['admin','super_admin']) au, crises c
  order by c.number
$$;

grant execute on function fn_admin_crisis_list() to authenticated;
revoke execute on function fn_admin_crisis_list() from anon;

-- ---------------------------------------------------------------------------
-- Admin/super_admin: every active team's tier + applied effect for a crisis
-- (replaces the old manually-resolved crisis_affected_teams view).
-- ---------------------------------------------------------------------------
create or replace function fn_admin_crisis_effects(p_crisis_id int)
returns table (team_id int, team_code text, tier text, applied jsonb)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select t.id, t.team_code, cte.tier, cte.applied
  from fn_require_role(array['admin','super_admin']) au
  join teams t on t.is_active
  left join crisis_team_effects cte on cte.crisis_id = p_crisis_id and cte.team_id = t.id
  order by t.team_code
$$;

grant execute on function fn_admin_crisis_effects(int) to authenticated;
revoke execute on function fn_admin_crisis_effects(int) from anon;
