-- Round 3, rebuilt: Crisis + Trading system, replacing the old tier-based
-- Market Mayhem (mayhem_events/market_tiers/team_mayhem_responses).
--
-- Model: 2-3 predetermined crises are set up in advance (title, description,
-- a manually-picked affected-team list, a manually-picked "useful action
-- card" list). Once triggered, a crisis is visible to every team (players
-- included). An affected team that already holds (or trades for) a useful
-- card is marked protected; a team that can't is marked 'penalized' and the
-- Super Admin manually reduces their resources via the existing resource
-- adjuster (no automatic resource math here — the exact penalty numbers are
-- supplied per crisis by the game design, not computed).
--
-- Trades are admin-processed: two teams privately agree off-app, then an
-- admin enters both team codes + the two action_card ids (+ optional money
-- from either side) and executes the swap in one transaction.

-- ---------------------------------------------------------------------------
-- Drop the old Market Mayhem objects entirely (superseded).
--
-- fn_trigger_mayhem_event/fn_record_mayhem_response are dropped automatically
-- by CASCADE below (their return type is one of these tables' row type, a
-- hard catalog dependency Postgres tracks regardless of function language).
-- The read-only LANGUAGE SQL functions are NOT auto-dropped that way — a SQL
-- function's body isn't dependency-tracked against tables it merely queries
-- — so they're dropped explicitly here to avoid leaving dangling, still
-- granted functions that would 500 at runtime.
-- ---------------------------------------------------------------------------
drop function if exists fn_mayhem_current();
drop function if exists fn_mayhem_events();
drop function if exists fn_mayhem_team_status();

alter table game_state drop column if exists current_mayhem_event_id;
drop table if exists team_mayhem_responses cascade;
drop table if exists market_tiers cascade;
drop table if exists mayhem_events cascade;

-- ---------------------------------------------------------------------------
-- Crises: fixed sequential events, same trigger-in-order pattern as before.
-- ---------------------------------------------------------------------------
create table crises (
  id            serial primary key,
  number        smallint not null unique check (number between 1 and 10),
  title         text not null,
  description   text not null,
  is_triggered  boolean not null default false,
  triggered_at  timestamptz,
  triggered_by  uuid references users(id) on delete set null
);

-- which action cards count as "useful" (protect a team) against this crisis
create table crisis_useful_cards (
  crisis_id       int not null references crises(id) on delete cascade,
  action_card_id  int not null references action_cards(id),
  primary key (crisis_id, action_card_id)
);

-- manually-picked affected teams for a crisis, and each one's resolution
create table crisis_affected_teams (
  id           bigserial primary key,
  crisis_id    int not null references crises(id) on delete cascade,
  team_id      int not null references teams(id) on delete cascade,
  -- pending: not yet resolved | used_card: had/used a useful card, protected
  -- traded: acquired a useful card via an admin-processed trade, protected
  -- penalized: no useful card obtained; Super Admin manually reduced resources
  status       text not null default 'pending' check (status in ('pending','used_card','traded','penalized')),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references users(id) on delete set null,
  unique (crisis_id, team_id)
);

-- ---------------------------------------------------------------------------
-- Trades: admin-processed card (and optional money) exchange between two
-- teams. Not a proposal/accept flow — the two teams have already agreed
-- off-app; an admin just executes it.
-- ---------------------------------------------------------------------------
create table trades (
  id                bigserial primary key,
  crisis_id         int references crises(id) on delete set null,
  team_a_id         int not null references teams(id) on delete cascade,
  team_a_card_id    uuid not null references team_action_cards(id),
  team_b_id         int not null references teams(id) on delete cascade,
  team_b_card_id    uuid not null references team_action_cards(id),
  money_team_id     int references teams(id),        -- which team PAYS, if any
  money_amount      int not null default 0 check (money_amount >= 0),
  processed_by      uuid references users(id) on delete set null,
  request_id        uuid not null unique,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Trading feature toggle: one row per super_admin. The feature is
-- effectively ON if ANY row is enabled=true, and only goes OFF once every
-- super_admin's row is false (a single super_admin can turn it on alone, but
-- turning it off again requires every super_admin to also turn theirs off).
-- ---------------------------------------------------------------------------
create table trade_feature_toggles (
  super_admin_id  uuid primary key references users(id) on delete cascade,
  enabled         boolean not null default false,
  updated_at      timestamptz not null default now()
);

do $$
declare t text;
begin
  for t in select unnest(array['crises','crisis_useful_cards','crisis_affected_teams','trades','trade_feature_toggles']) loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
end $$;
