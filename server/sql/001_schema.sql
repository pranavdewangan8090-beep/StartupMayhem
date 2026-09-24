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

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Card templates (infinite supply: teams reference a template, never "own" it)
-- ---------------------------------------------------------------------------
create table identity_cards (
  id               serial primary key,
  category         text not null check (category in ('market','customer','problem','mission','resources')),
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

create table action_cards (
  id             serial primary key,
  category       text not null check (category in ('self_help','attack','deal','special')),
  name           text not null unique,
  description    text not null default '',
  effect_text    text not null default '',
  -- effect objects: {"cash_l":int,"customers":int,"reputation":int,"innovation":int}
  self_effect    jsonb not null default '{}'::jsonb,  -- applied to the player of the card
  target_effect  jsonb,                               -- attack cards: applied to the target team
  partner_effect jsonb,                               -- deal cards: applied to the partner team
  is_active      boolean not null default true
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
  market_card_id     int not null references identity_cards(id),
  customer_card_id   int not null references identity_cards(id),
  problem_card_id    int not null references identity_cards(id),
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

-- ---------------------------------------------------------------------------
-- Global game switches (single row)
-- ---------------------------------------------------------------------------
create table game_state (
  id                      smallint primary key default 1 check (id = 1),
  r1_replace_open         boolean not null default true,
  r2_selection_open       boolean not null default false,
  marketplace_open        boolean not null default false,
  card_play_open          boolean not null default true,
  current_mayhem_event_id int,
  updated_at              timestamptz not null default now()
);
insert into game_state (id) values (1);

-- ---------------------------------------------------------------------------
-- Round 1: identity card replacements (max 3 per team, enforced on teams row)
-- ---------------------------------------------------------------------------
create table card_replacements (
  id           bigserial primary key,
  team_id      int not null references teams(id) on delete cascade,
  category     text not null,
  old_card_id  int not null references identity_cards(id),
  new_card_id  int not null references identity_cards(id),
  request_id   uuid not null unique,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Action cards held by teams
-- ---------------------------------------------------------------------------
create table team_action_cards (
  id              uuid primary key default gen_random_uuid(),
  team_id         int not null references teams(id) on delete cascade,
  action_card_id  int not null references action_cards(id),
  -- held: usable | listed: on marketplace (not usable) | pending: deal awaiting partner | used: consumed
  status          text not null default 'held' check (status in ('held','listed','pending','used')),
  source          text not null check (source in ('r2','trade','admin')),
  request_id      uuid unique,
  acquired_at     timestamptz not null default now(),
  used_at         timestamptz
);
create index team_action_cards_team on team_action_cards(team_id);
-- R2: a team may request each action card at most once
create unique index team_action_cards_r2_unique on team_action_cards(team_id, action_card_id) where source = 'r2';

-- Every play of an action card (attack log, deal requests, self-help history)
create table card_plays (
  id                   bigserial primary key,
  team_action_card_id  uuid not null unique references team_action_cards(id) on delete cascade,
  action_card_id       int not null references action_cards(id),
  team_id              int not null references teams(id) on delete cascade,
  other_team_id        int references teams(id) on delete cascade,   -- attack target or deal partner
  status               text not null check (status in ('applied','pending','rejected','cancelled')),
  self_applied         jsonb,   -- deltas actually applied after caps
  other_applied        jsonb,
  request_id           uuid not null unique,
  created_at           timestamptz not null default now(),
  resolved_at          timestamptz
);
create index card_plays_other on card_plays(other_team_id);

-- ---------------------------------------------------------------------------
-- Marketplace: 1 card for 1 card, no money
-- ---------------------------------------------------------------------------
create table market_listings (
  id                   bigserial primary key,
  team_action_card_id  uuid not null references team_action_cards(id) on delete cascade,
  seller_team_id       int not null references teams(id) on delete cascade,
  status               text not null default 'active' check (status in ('active','sold','unlisted')),
  request_id           uuid not null unique,
  created_at           timestamptz not null default now(),
  closed_at            timestamptz
);
create unique index market_listings_one_active on market_listings(team_action_card_id) where status = 'active';

create table trade_offers (
  id               bigserial primary key,
  listing_id       bigint not null references market_listings(id) on delete cascade,
  buyer_team_id    int not null references teams(id) on delete cascade,
  offered_card_id  uuid not null references team_action_cards(id) on delete cascade,
  status           text not null default 'pending' check (status in ('pending','accepted','rejected','withdrawn','void')),
  request_id       uuid not null unique,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);
create unique index trade_offers_one_pending on trade_offers(listing_id, buyer_team_id) where status = 'pending';
create index trade_offers_offered_card on trade_offers(offered_card_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Market Mayhem
-- ---------------------------------------------------------------------------
create table mayhems (
  id           serial primary key,
  title        text not null unique,
  description  text not null,
  effect_text  text not null,
  tags         text[] not null default '{}' check (tags <@ array['finance','social','urban','logistics']::text[]),
  is_active    boolean not null default true
);

-- special action cards that protect the holder from a given mayhem (checked manually by admins)
create table mayhem_protections (
  mayhem_id       int not null references mayhems(id) on delete cascade,
  action_card_id  int not null references action_cards(id) on delete cascade,
  primary key (mayhem_id, action_card_id)
);

create table mayhem_events (
  id            serial primary key,
  mayhem_id     int not null references mayhems(id),
  triggered_by  uuid references users(id) on delete set null,
  triggered_at  timestamptz not null default now()
);
alter table game_state
  add constraint game_state_mayhem_fk foreign key (current_mayhem_event_id) references mayhem_events(id);

-- ---------------------------------------------------------------------------
-- Scoring and audit
-- ---------------------------------------------------------------------------
-- Every resource change (admin, card, replacement) with before/after snapshot
create table resource_adjustments (
  id             bigserial primary key,
  team_id        int not null references teams(id) on delete cascade,
  actor_user_id  uuid references users(id) on delete set null,
  source         text not null check (source in ('admin','card','replacement')),
  delta          jsonb not null,   -- requested change
  applied        jsonb not null,   -- change after caps
  before         jsonb not null,
  after          jsonb not null,
  reason         text not null default '',
  request_id     uuid unique,
  created_at     timestamptz not null default now()
);
create index resource_adjustments_team on resource_adjustments(team_id, created_at desc);

-- Decision points: append-only deltas per round. Hidden from players.
create table decision_points (
  id             bigserial primary key,
  team_id        int not null references teams(id) on delete cascade,
  round          smallint not null check (round between 1 and 6),
  delta          smallint not null check (delta between -30 and 30 and delta <> 0),
  actor_user_id  uuid references users(id) on delete set null,
  note           text not null default '',
  request_id     uuid not null unique,
  created_at     timestamptz not null default now()
);
create index decision_points_team on decision_points(team_id);

create table notifications (
  id          bigserial primary key,
  team_id     int not null references teams(id) on delete cascade,
  type        text not null,
  title       text not null,
  body        text not null default '',
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_team on notifications(team_id, created_at desc);

-- Super admin / structural actions (toggles, mayhem, team management)
create table audit_log (
  id             bigserial primary key,
  actor_user_id  uuid references users(id) on delete set null,
  action         text not null,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

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
