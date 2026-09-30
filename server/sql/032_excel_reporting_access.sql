-- Emergency fallback: lets an Excel sheet (or any Postgres client — Power
-- Query, DBeaver, psql) connect DIRECTLY to the database over the native
-- Postgres protocol, bypassing the deployed website entirely. If the site
-- itself breaks during the event, this still works as long as Supabase's
-- Postgres is up.
--
-- Read-only, and deliberately narrow: a new `excel_reporting` role can only
-- SELECT from a handful of curated views defined here — never the raw
-- tables (which would expose password_hash, _app_secrets, etc.), and
-- nothing it can write. This is a monitoring fallback, not a way to run the
-- game from Excel; the game's actual write paths (adjusting resources,
-- triggering crises, ...) all live in validated RPC functions
-- (fn_clamp_team, row locks, request-id dedup) that a raw table UPDATE from
-- Excel would bypass entirely, risking corrupted data mid-event. If you
-- want a safe way to write from Excel too, that needs its own careful
-- design — ask for it as a follow-up rather than editing these views'
-- grants directly.
--
-- SECURITY: this file creates the role with a placeholder password nobody
-- knows (a fresh random UUID, immediately discarded) — exactly like
-- _app_secrets, the real password is never committed to source control.
-- Set the real one yourself right after applying this:
--   node scripts/applySql.js --commit sql/032_excel_reporting_access.sql
--   psql "$DATABASE_URL" -c "alter role excel_reporting with password '<pick one>';"
-- (or run that ALTER through scripts/applySql.js with a one-off local file
-- you never commit).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'excel_reporting') then
    execute format('create role excel_reporting login password %L', gen_random_uuid()::text);
  end if;
end $$;

grant usage on schema public to excel_reporting;

-- Precomputes the same scoring formula LeaderboardTab.jsx does client-side
-- (Resource 30% + Decision 70% + Secret Mission bonus), so Excel doesn't
-- need to replicate that math — just read totalScore.
create or replace view v_excel_leaderboard as
select
  t.team_code,
  t.cash_l,
  t.customers,
  t.reputation,
  t.innovation,
  t.decision_points,
  t.mission_completed,
  mc.title as mission_title,
  coalesce(mc.bonus_points, 0) as mission_bonus_points,
  round(
    (0.3 * (least(t.cash_l / 10.0, 10) / 10 * 100))
    + (0.3 * (least(t.customers / 20000.0, 10) / 10 * 100))
    + (0.2 * (t.reputation / 5.0 * 100))
    + (0.2 * (t.innovation / 10.0 * 100))
  , 1) as resource_score,
  greatest(0, least(100, t.decision_points)) as decision_score,
  round(
    0.3 * (
      (0.3 * (least(t.cash_l / 10.0, 10) / 10 * 100))
      + (0.3 * (least(t.customers / 20000.0, 10) / 10 * 100))
      + (0.2 * (t.reputation / 5.0 * 100))
      + (0.2 * (t.innovation / 10.0 * 100))
    )
    + 0.7 * greatest(0, least(100, t.decision_points))
    + (case when t.mission_completed then coalesce(mc.bonus_points, 0) else 0 end)
  , 1) as total_score
from teams t
left join identity_cards mc on mc.id = t.mission_card_id
where t.is_active
order by total_score desc;

comment on view v_excel_leaderboard is 'Same scoring formula as the Super Admin Leaderboard tab. Excel-friendly: no jsonb, no joins needed.';

create or replace view v_excel_teams as
select
  t.team_code,
  t.is_active,
  t.cash_l,
  t.customers,
  t.reputation,
  t.innovation,
  t.decision_points,
  t.replacements_used,
  t.mission_completed,
  mk.title as market_title,
  cu.title as customer_title,
  ms.title as mission_title,
  rc.title as resources_title,
  t.created_at
from teams t
join identity_cards mk on mk.id = t.market_card_id
join identity_cards cu on cu.id = t.customer_card_id
join identity_cards ms on ms.id = t.mission_card_id
join identity_cards rc on rc.id = t.resources_card_id
order by t.team_code;

create or replace view v_excel_hands as
select
  t.team_code,
  ac.category,
  ac.name as card_name,
  tac.status,
  tac.acquired_at,
  tac.used_at
from team_action_cards tac
join teams t on t.id = tac.team_id
join action_cards ac on ac.id = tac.action_card_id
order by t.team_code, ac.category;

create or replace view v_excel_crises as
select
  c.number,
  c.title,
  c.description,
  c.is_triggered,
  c.triggered_at,
  t.team_code,
  cte.tier,
  cte.applied
from crises c
left join crisis_team_effects cte on cte.crisis_id = c.id
left join teams t on t.id = cte.team_id
order by c.number, t.team_code;

comment on view v_excel_crises is 'One row per (crisis, team) once a crisis has been triggered and its per-team effect computed; crises not yet triggered still show one row with team_code null.';

-- Login IDs, never password_hash — enough to see who's who without
-- exposing anything sensitive.
create or replace view v_excel_accounts as
select role, login_id, is_active, last_login_at
from users
order by role, login_id;

grant select on v_excel_leaderboard, v_excel_teams, v_excel_hands, v_excel_crises, v_excel_accounts
  to excel_reporting;

-- Belt and braces: explicitly confirm this role can reach nothing else —
-- no raw tables, no other schema's objects, no functions.
revoke all on all tables in schema public from excel_reporting;
grant select on v_excel_leaderboard, v_excel_teams, v_excel_hands, v_excel_crises, v_excel_accounts
  to excel_reporting;
