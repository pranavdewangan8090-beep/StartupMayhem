-- Startup Mayhem: database schema
-- Run in the Supabase SQL editor (or psql) in file order: 001, 002, 003, 004.
--
-- Units
--   cash_l      : Cash in rupee LAKHS (10 = ₹1M, 5 = ₹0.5M). Integers avoid float errors.
--   customers   : raw customer count (20000 = 20k).
--   reputation  : 0..5
--   innovation  : 0..10
--
-- The Node server is the ONLY client of this database. RLS is enabled on every
-- table with no policies, and anon/authenticated roles have no grants, so the
-- public Supabase REST API cannot read or write anything.
--
-- Kept deliberately simple: no separate audit/log tables. Every action updates
-- the relevant row directly (teams, cards, mayhems) with no history trail.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Card templates (infinite supply: teams reference a template, never "own" it)
-- ---------------------------------------------------------------------------
create table identity_cards (
  id               serial primary key,
  category         text not null check (category in ('market','customer','mission','resources')),
  number           smallint not null check (number between 1 and 20),
  title            text not null,
  tagline          text not null default '',
  description      text not null default '',
  -- mayhem tags this card's passive ability reacts to ('finance','social','urban','logistics','any')
  event_tags       text[] not null default '{}',
  bonus_points     smallint,                 -- secret mission cards only
  start_cash_l     int,                      -- starting resources cards only
  start_customers  int,
  start_reputation smallint,
  start_innovation smallint,
  unique (category, number)
);

-- 3 categories, one card of each per team: action (self-help style boosts),
-- deal (two-team pacts), special (AI-flavored boosts). No attack cards and no
-- marketplace/trading — a team's hand is exactly one of each, held for the game.
create table action_cards (
  id             serial primary key,
  category       text not null check (category in ('action', 'deal', 'special')),
  name           text not null unique,
  description    text not null default '',
  effect_text    text not null default '',
  -- effect objects: {"cash_l":int,"customers":int,"reputation":int,"innovation":int}
  self_effect    jsonb not null default '{}'::jsonb,  -- applied to the player of the card
  partner_effect jsonb,                               -- deal cards: applied to the partner team
  is_active      boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Round 3: Market Mayhem — 3 fixed sequential events. Each Market identity
-- card sits in one of 4 tiers per event (market_tiers); a team's response
-- (accept/spend/adapt/partner) combines with its tier to compute the exact
-- resource delta, applied automatically (see fn_record_mayhem_response).
-- Admin/Super Admin record each team's response manually — players do not
-- interact with this in the app.
-- ---------------------------------------------------------------------------
create table mayhem_events (
  id            serial primary key,
  number        smallint not null unique check (number between 1 and 3),
  title         text not null,
  story_text    text not null,
  effect_text   text not null,
  tags          text[] not null default '{}',
  -- per-tier resource delta for this event, e.g. {"hit_hard":{"customers":-40000},"hit":{"customers":-20000},"unaffected":{},"gains":{"customers":20000}}
  tier_deltas   jsonb not null,
  is_triggered  boolean not null default false,
  triggered_at  timestamptz,
  triggered_by  uuid
);

-- which tier each Market identity card falls into, per event
create table market_tiers (
  mayhem_event_id  int not null references mayhem_events(id) on delete cascade,
  market_card_id   int not null references identity_cards(id),
  tier             text not null check (tier in ('hit_hard', 'hit', 'unaffected', 'gains')),
  primary key (mayhem_event_id, market_card_id)
);

-- ---------------------------------------------------------------------------
-- Teams and users
-- ---------------------------------------------------------------------------
create table teams (
  id                 serial primary key,
  team_code          text not null unique,
  cash_l             int not null default 0 check (cash_l >= 0),
  customers          int not null default 0 check (customers >= 0),
  reputation         smallint not null default 0 check (reputation between 0 and 5),
  innovation         smallint not null default 0 check (innovation between 0 and 10),
  replacements_used  smallint not null default 0 check (replacements_used between 0 and 3),
  -- running total of decision points across all rounds (hidden from players)
  decision_points    int not null default 0,
  market_card_id     int not null references identity_cards(id),
  customer_card_id   int not null references identity_cards(id),
  mission_card_id    int not null references identity_cards(id),
  resources_card_id  int not null references identity_cards(id),
  mission_completed  boolean not null default false,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now()
);

create table users (
  id               uuid primary key default gen_random_uuid(),
  role             text not null check (role in ('player','admin','super_admin')),
  login_id         text not null,
  password_hash    text not null,
  team_id          int references teams(id) on delete cascade,
  is_active        boolean not null default true,
  -- bumped on player login/logout: older tokens stop working (one phone per team)
  session_version  int not null default 0,
  last_login_at    timestamptz,
  created_at       timestamptz not null default now(),
  unique (role, login_id),
  check ((role = 'player') = (team_id is not null))
);
create unique index users_one_login_per_team on users(team_id) where team_id is not null;

alter table mayhem_events add constraint mayhem_events_triggered_by_fk foreign key (triggered_by) references users(id) on delete set null;

-- one response per team per event: which option they picked, and the exact
-- delta that was applied (computed from their Market's tier + the response)
create table team_mayhem_responses (
  id               bigserial primary key,
  mayhem_event_id  int not null references mayhem_events(id) on delete cascade,
  team_id          int not null references teams(id) on delete cascade,
  tier             text not null check (tier in ('hit_hard', 'hit', 'unaffected', 'gains')),
  response         text not null check (response in ('accept', 'spend', 'adapt', 'partner')),
  partner_team_id  int references teams(id) on delete set null,
  applied          jsonb not null,
  recorded_by      uuid references users(id) on delete set null,
  request_id       uuid not null unique,
  created_at       timestamptz not null default now(),
  unique (mayhem_event_id, team_id)
);

-- ---------------------------------------------------------------------------
-- Global game switches (single row)
-- ---------------------------------------------------------------------------
create table game_state (
  id                      smallint primary key default 1 check (id = 1),
  r1_replace_open         boolean not null default true,
  r2_selection_open       boolean not null default false,
  card_play_open          boolean not null default true,
  current_mayhem_event_id int references mayhem_events(id),
  updated_at              timestamptz not null default now()
);
insert into game_state (id) values (1);

-- ---------------------------------------------------------------------------
-- Action cards held by teams: exactly one per category (action/deal/special),
-- no listing/trading — a card is held until played.
-- ---------------------------------------------------------------------------
create table team_action_cards (
  id              uuid primary key default gen_random_uuid(),
  team_id         int not null references teams(id) on delete cascade,
  action_card_id  int not null references action_cards(id),
  -- held: usable | pending: deal awaiting partner | used: consumed
  status          text not null default 'held' check (status in ('held','pending','used')),
  source          text not null check (source in ('r2','admin')),
  request_id      uuid unique,
  acquired_at     timestamptz not null default now(),
  used_at         timestamptz
);
create index team_action_cards_team on team_action_cards(team_id);
-- R2: a team may request each action card at most once
create unique index team_action_cards_r2_unique on team_action_cards(team_id, action_card_id) where source = 'r2';

-- Every play of an action card (deal or self-play) — tracks in-flight deal
-- state (pending/applied/rejected/cancelled), not a historical log.
create table card_plays (
  id                   bigserial primary key,
  team_action_card_id  uuid not null unique references team_action_cards(id) on delete cascade,
  action_card_id       int not null references action_cards(id),
  team_id              int not null references teams(id) on delete cascade,
  other_team_id        int references teams(id) on delete cascade,   -- deal partner
  status               text not null check (status in ('applied','pending','rejected','cancelled')),
  request_id           uuid not null unique,
  created_at           timestamptz not null default now()
);
create index card_plays_other on card_plays(other_team_id);

-- ---------------------------------------------------------------------------
-- Lock down the public Supabase API: only the server (postgres role) gets in.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
end $$;
