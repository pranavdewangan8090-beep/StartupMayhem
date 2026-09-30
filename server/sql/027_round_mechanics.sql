-- Round mechanics: card supply cap, paired deal cards with a timer, crisis
-- reveal showing per-tier effects instead of team lists, and team merging
-- for Round 5.
--
-- Design notes (confirmed with the game organizers):
--  * Card cap: exactly 3 physical copies of each of the 45 distinct action
--    cards exist (15 action + 15 deal + 15 special × 3 = 135 printouts), so
--    no card may ever be issued to more than 3 teams. Trades only move an
--    already-issued copy between teams — they never create a new one — so
--    capping fn_issue_starting_hand's initial draw is sufficient.
--  * Deal cards are used in pairs: accepting an offer applies AND consumes
--    BOTH teams' held deal cards (not just the initiator's). If the target
--    team's own deal card isn't held (already used/traded away), a
--    proposal is refused outright rather than sitting as a dead offer.
--  * A pending deal auto-expires 2 minutes after it's proposed. There's no
--    cron here — expiry is enforced lazily (checked whenever a deal is
--    read or acted on), which needs no extra infrastructure and is at most
--    one poll cycle (4s) late on the client.
--  * Team merge (Round 5): averages resources, keeps team A's identity
--    cards (no rule was given for which pair to keep), combines both
--    teams' card hands under the new merged team, and — per an explicit
--    "remove those teams from the database" instruction — deletes both
--    original team rows. That cascade-deletes their card_plays / trades /
--    crisis_team_effects history; there is no way to merge without losing
--    it given the schema's on-delete-cascade FKs, so this is a known,
--    deliberate trade-off, not an oversight.
--  * Both original teams' logins keep working after a merge and can be
--    logged in at the same time — they become two separate `users` rows
--    pointing at the same (new) team_id, which already works today because
--    session_version is per-user-row, not per-team. This needs
--    users_one_login_per_team dropped, since that constraint assumed
--    exactly one login per team.

-- ---------------------------------------------------------------------------
-- Card supply cap: at most 3 teams may ever hold a given specific card.
-- ---------------------------------------------------------------------------
create or replace function fn_issue_starting_hand(p_team_id int)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_category text;
  v_card_id int;
begin
  foreach v_category in array array['action', 'deal', 'special'] loop
    if not exists (
      select 1 from team_action_cards tac join action_cards ac on ac.id = tac.action_card_id
      where tac.team_id = p_team_id and ac.category = v_category
    ) then
      select ac.id into v_card_id
      from action_cards ac
      where ac.category = v_category and ac.is_active
        -- team_action_cards rows are only ever inserted here, never for a
        -- 2nd+ copy — a trade just re-points an existing row's team_id — so
        -- this count is exactly "how many of the 3 physical copies are
        -- already out"
        and (select count(*) from team_action_cards where action_card_id = ac.id) < 3
      order by random() limit 1;

      if v_card_id is null then
        raise exception 'NO_CARDS_AVAILABLE_IN_CATEGORY';
      end if;

      insert into team_action_cards (team_id, action_card_id, status, source)
      values (p_team_id, v_card_id, 'held', 'r2');
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Deal expiry: lazily reject any pending offer older than 2 minutes.
-- Internal helper only — no grant, matches fn_clamp_team's pattern.
-- ---------------------------------------------------------------------------
create or replace function fn_expire_stale_deal_plays()
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update team_action_cards set status = 'held'
  where id in (
    select team_action_card_id from card_plays
    where status = 'pending' and created_at < now() - interval '2 minutes'
  );
  update card_plays set status = 'rejected'
  where status = 'pending' and created_at < now() - interval '2 minutes';
end;
$$;

-- ---------------------------------------------------------------------------
-- Deal cards: paired effects + refuse a proposal the target can never accept
-- ---------------------------------------------------------------------------
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

  perform fn_expire_stale_deal_plays();

  if exists (select 1 from card_plays where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if (select card_play_open from game_state where id = 1) is not true then
    raise exception 'CARD_PLAY_CLOSED';
  end if;
  if p_partner_team_id = v_team_id then raise exception 'CANNOT_TARGET_SELF'; end if;
  if not exists (select 1 from teams where id = p_partner_team_id and is_active) then
    raise exception 'PARTNER_NOT_FOUND';
  end if;

  select * into v_tac from team_action_cards where id = p_team_action_card_id for update;
  if v_tac.id is null or v_tac.team_id <> v_team_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_tac.status <> 'held' then raise exception 'CARD_NOT_AVAILABLE'; end if;

  select * into v_card from action_cards where id = v_tac.action_card_id;
  if v_card.category <> 'deal' then raise exception 'WRONG_CARD_TYPE'; end if;

  if (select cash_l from teams where id = v_team_id) + coalesce((v_card.self_effect->>'cash_l')::int, 0) < 0 then
    raise exception 'INSUFFICIENT_CASH';
  end if;

  -- deals are always used in pairs — refuse outright if the target has no
  -- deal card of their own to pair it with (already used, traded away, or
  -- never had one), rather than leaving a dead offer sitting as pending
  if not exists (
    select 1 from team_action_cards tac join action_cards ac on ac.id = tac.action_card_id
    where tac.team_id = p_partner_team_id and ac.category = 'deal' and tac.status = 'held'
  ) then
    raise exception 'PARTNER_HAS_NO_DEAL_CARD';
  end if;

  update team_action_cards set status = 'pending' where id = p_team_action_card_id;

  insert into card_plays (team_action_card_id, action_card_id, team_id, other_team_id, status, request_id)
  values (p_team_action_card_id, v_card.id, v_team_id, p_partner_team_id, 'pending', p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function fn_play_deal_card(uuid, int, uuid) to authenticated;

create or replace function fn_respond_deal_card(p_card_play_id bigint, p_accept boolean, p_request_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_partner_team_id int; -- the RESPONDER's team id
  v_play card_plays%rowtype;
  v_card_a action_cards%rowtype; -- initiator's card
  v_card_b action_cards%rowtype; -- responder's own deal card
  v_tac_b team_action_cards%rowtype;
  v_initiator teams%rowtype;
  v_partner teams%rowtype;
  v_c record;
  v_initiator_after jsonb;
  v_partner_after jsonb;
begin
  select au.team_id into v_partner_team_id from fn_auth_user() au where au.app_role = 'player';
  if v_partner_team_id is null then raise exception 'NOT_AUTHENTICATED'; end if;

  perform fn_expire_stale_deal_plays();

  select * into v_play from card_plays where id = p_card_play_id for update;
  if v_play.id is null or v_play.other_team_id <> v_partner_team_id then raise exception 'DEAL_NOT_FOUND'; end if;
  -- covers both "already answered" and "just auto-expired above"
  if v_play.status <> 'pending' then raise exception 'DEAL_ALREADY_RESOLVED'; end if;

  select * into v_card_a from action_cards where id = v_play.action_card_id;

  if not p_accept then
    update card_plays set status = 'rejected' where id = p_card_play_id;
    update team_action_cards set status = 'held' where id = v_play.team_action_card_id;
    return jsonb_build_object('accepted', false);
  end if;

  if (select card_play_open from game_state where id = 1) is not true then
    raise exception 'CARD_PLAY_CLOSED';
  end if;

  -- the responder's own deal card is required too — deals are always used
  -- in pairs, so accepting applies AND consumes BOTH cards
  select * into v_tac_b from team_action_cards tac
    join action_cards ac on ac.id = tac.action_card_id
    where tac.team_id = v_partner_team_id and ac.category = 'deal' and tac.status = 'held'
    for update;
  if v_tac_b.id is null then raise exception 'YOUR_DEAL_CARD_UNAVAILABLE'; end if;
  select * into v_card_b from action_cards where id = v_tac_b.action_card_id;

  if v_play.team_id < v_partner_team_id then
    select * into v_initiator from teams where id = v_play.team_id for update;
    select * into v_partner from teams where id = v_partner_team_id for update;
  else
    select * into v_partner from teams where id = v_partner_team_id for update;
    select * into v_initiator from teams where id = v_play.team_id for update;
  end if;

  if not v_initiator.is_active then raise exception 'DEAL_NOT_FOUND'; end if;

  -- net effect on the initiator = their own card's self_effect + the
  -- responder's card's partner_effect (and symmetrically for the
  -- responder) — both cards' printed effects land, on both teams
  if v_initiator.cash_l
       + coalesce((v_card_a.self_effect->>'cash_l')::int,0)
       + coalesce((v_card_b.partner_effect->>'cash_l')::int,0) < 0 then
    raise exception 'INITIATOR_INSUFFICIENT_CASH';
  end if;
  if v_partner.cash_l
       + coalesce((v_card_b.self_effect->>'cash_l')::int,0)
       + coalesce((v_card_a.partner_effect->>'cash_l')::int,0) < 0 then
    raise exception 'INSUFFICIENT_CASH';
  end if;

  v_c := fn_clamp_team(
    v_initiator.cash_l
      + coalesce((v_card_a.self_effect->>'cash_l')::int,0) + coalesce((v_card_b.partner_effect->>'cash_l')::int,0),
    v_initiator.customers
      + coalesce((v_card_a.self_effect->>'customers')::int,0) + coalesce((v_card_b.partner_effect->>'customers')::int,0),
    v_initiator.reputation
      + coalesce((v_card_a.self_effect->>'reputation')::int,0) + coalesce((v_card_b.partner_effect->>'reputation')::int,0),
    v_initiator.innovation
      + coalesce((v_card_a.self_effect->>'innovation')::int,0) + coalesce((v_card_b.partner_effect->>'innovation')::int,0));
  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = v_play.team_id;

  v_c := fn_clamp_team(
    v_partner.cash_l
      + coalesce((v_card_b.self_effect->>'cash_l')::int,0) + coalesce((v_card_a.partner_effect->>'cash_l')::int,0),
    v_partner.customers
      + coalesce((v_card_b.self_effect->>'customers')::int,0) + coalesce((v_card_a.partner_effect->>'customers')::int,0),
    v_partner.reputation
      + coalesce((v_card_b.self_effect->>'reputation')::int,0) + coalesce((v_card_a.partner_effect->>'reputation')::int,0),
    v_partner.innovation
      + coalesce((v_card_b.self_effect->>'innovation')::int,0) + coalesce((v_card_a.partner_effect->>'innovation')::int,0));
  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = v_partner_team_id;

  v_initiator_after := fn_team_snapshot(v_play.team_id);
  v_partner_after := fn_team_snapshot(v_partner_team_id);

  update team_action_cards set status = 'used', used_at = now() where id = v_play.team_action_card_id;
  update team_action_cards set status = 'used', used_at = now() where id = v_tac_b.id;
  update card_plays set status = 'applied' where id = p_card_play_id;

  insert into card_plays (team_action_card_id, action_card_id, team_id, other_team_id, status, request_id)
  values (v_tac_b.id, v_tac_b.action_card_id, v_partner_team_id, v_play.team_id, 'applied', p_request_id);

  return jsonb_build_object('accepted', true, 'initiator_after', v_initiator_after, 'partner_after', v_partner_after);
end;
$$;

grant execute on function fn_respond_deal_card(bigint, boolean, uuid) to authenticated;

-- fn_deals_incoming / fn_deals_outgoing / fn_player_state now lazily expire
-- stale offers on every read, so the badge counts and lists clear promptly
-- even for a team that never opens the Action Cards tab.
drop function if exists fn_deals_incoming();
create function fn_deals_incoming()
returns table (
  id bigint, created_at timestamptz, name text, description text, effect_text text, from_team_code text
)
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform fn_expire_stale_deal_plays();
  return query
    select cp.id, cp.created_at, ac.name, ac.description, ac.effect_text, t.team_code
    from fn_auth_user() au
    join card_plays cp on cp.other_team_id = au.team_id and cp.status = 'pending'
    join action_cards ac on ac.id = cp.action_card_id
    join teams t on t.id = cp.team_id
    where au.app_role = 'player'
    order by cp.created_at;
end;
$$;

grant execute on function fn_deals_incoming() to authenticated;

drop function if exists fn_deals_outgoing();
create function fn_deals_outgoing()
returns table (id bigint, created_at timestamptz, team_action_card_id uuid, name text, to_team_code text)
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform fn_expire_stale_deal_plays();
  return query
    select cp.id, cp.created_at, cp.team_action_card_id, ac.name, t.team_code
    from fn_auth_user() au
    join card_plays cp on cp.team_id = au.team_id and cp.status = 'pending'
    join action_cards ac on ac.id = cp.action_card_id
    join teams t on t.id = cp.other_team_id
    where au.app_role = 'player'
    order by cp.created_at;
end;
$$;

grant execute on function fn_deals_outgoing() to authenticated;

drop function if exists fn_player_state();
create function fn_player_state()
returns table (
  r1_replace_open boolean, card_play_open boolean,
  action_card_count bigint, pending_deal_offers_in bigint,
  pending_deal_offers_out bigint, used_card_count bigint
)
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform fn_expire_stale_deal_plays();
  return query
    select gs.r1_replace_open, gs.card_play_open,
           (select count(*) from team_action_cards where team_id = au.team_id),
           (select count(*) from card_plays where other_team_id = au.team_id and status = 'pending'),
           (select count(*) from card_plays where team_id = au.team_id and status = 'pending'),
           (select count(*) from team_action_cards where team_id = au.team_id and status = 'used')
    from game_state gs, fn_auth_user() au
    where gs.id = 1 and au.app_role = 'player';
end;
$$;

grant execute on function fn_player_state() to authenticated;

-- ---------------------------------------------------------------------------
-- Crisis reveal: show the effect for EACH tier, not which teams landed in
-- each one. tier_deltas mirrors crises.tier_deltas with decision_points
-- stripped from every tier (that field is super-admin-only everywhere else).
-- ---------------------------------------------------------------------------
drop function if exists fn_crisis_public();
create function fn_crisis_public()
returns table (crisis_id int, number smallint, title text, description text, tier text, applied jsonb, tier_deltas jsonb)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select c.id, c.number, c.title, c.description, cte.tier, cte.applied - 'decision_points',
    jsonb_build_object(
      'hit_hard', coalesce(c.tier_deltas->'hit_hard', '{}'::jsonb) - 'decision_points',
      'hit', coalesce(c.tier_deltas->'hit', '{}'::jsonb) - 'decision_points',
      'unaffected', coalesce(c.tier_deltas->'unaffected', '{}'::jsonb) - 'decision_points',
      'gains', coalesce(c.tier_deltas->'gains', '{}'::jsonb) - 'decision_points'
    )
  from fn_require_role(array['player','admin','super_admin']) au
  join crises c on c.is_triggered
  left join crisis_team_effects cte on cte.crisis_id = c.id and cte.team_id = au.team_id
  order by c.number
$$;

grant execute on function fn_crisis_public() to authenticated;

-- ---------------------------------------------------------------------------
-- Team merge (Round 5).
-- ---------------------------------------------------------------------------
drop index if exists users_one_login_per_team;

create table if not exists team_merges (
  id              bigserial primary key,
  merged_team_id  int not null references teams(id) on delete cascade,
  team_a_code     text not null,
  team_b_code     text not null,
  merged_by       uuid references users(id) on delete set null,
  created_at      timestamptz not null default now()
);
alter table team_merges enable row level security;
revoke all on team_merges from anon, authenticated;

create or replace function fn_super_merge_teams(p_team_a_id int, p_team_b_id int)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_a teams%rowtype;
  v_b teams%rowtype;
  v_new_id int;
  v_new_code text;
  v_seq int;
begin
  select user_id into v_actor from fn_require_role(array['super_admin']);

  if p_team_a_id = p_team_b_id then raise exception 'CANNOT_MERGE_SAME_TEAM'; end if;

  if p_team_a_id < p_team_b_id then
    select * into v_a from teams where id = p_team_a_id for update;
    select * into v_b from teams where id = p_team_b_id for update;
  else
    select * into v_b from teams where id = p_team_b_id for update;
    select * into v_a from teams where id = p_team_a_id for update;
  end if;
  if v_a.id is null or v_b.id is null then raise exception 'TEAM_NOT_FOUND'; end if;
  if not v_a.is_active or not v_b.is_active then raise exception 'TEAM_NOT_FOUND'; end if;

  select count(*) + 1 into v_seq from team_merges;
  v_new_code := 'TM' || lpad(v_seq::text, 2, '0');

  -- identity cards: kept from team A (no rule was specified for which pair
  -- of the two teams' cards a merged team should carry)
  insert into teams (
    team_code, cash_l, customers, reputation, innovation, decision_points,
    market_card_id, customer_card_id, mission_card_id, resources_card_id,
    replacements_used, mission_completed
  ) values (
    v_new_code,
    round((v_a.cash_l + v_b.cash_l) / 2.0)::int,
    round((v_a.customers + v_b.customers) / 2.0)::int,
    round((v_a.reputation + v_b.reputation) / 2.0)::int,
    round((v_a.innovation + v_b.innovation) / 2.0)::int,
    round((v_a.decision_points + v_b.decision_points) / 2.0)::int,
    v_a.market_card_id, v_a.customer_card_id, v_a.mission_card_id, v_a.resources_card_id,
    greatest(v_a.replacements_used, v_b.replacements_used),
    v_a.mission_completed or v_b.mission_completed
  )
  returning id into v_new_id;

  -- both teams' logins keep working, now resolving to the merged team —
  -- relies on users_one_login_per_team having been dropped above
  update users set team_id = v_new_id where team_id in (p_team_a_id, p_team_b_id);

  -- both hands combine under the merged team
  update team_action_cards set team_id = v_new_id where team_id in (p_team_a_id, p_team_b_id);

  insert into team_merges (merged_team_id, team_a_code, team_b_code, merged_by)
  values (v_new_id, v_a.team_code, v_b.team_code, v_actor);

  -- remove the two original teams now that nothing still points to them —
  -- cascade-deletes their card_plays/trades/crisis_team_effects history
  delete from teams where id in (p_team_a_id, p_team_b_id);

  return jsonb_build_object('mergedTeamId', v_new_id, 'teamCode', v_new_code, 'teamACode', v_a.team_code, 'teamBCode', v_b.team_code);
end;
$$;

grant execute on function fn_super_merge_teams(int, int) to authenticated;

create or replace function fn_super_team_merges()
returns table (id bigint, merged_team_code text, team_a_code text, team_b_code text, merged_by_login text, created_at timestamptz)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select tm.id, t.team_code, tm.team_a_code, tm.team_b_code, u.login_id, tm.created_at
  from fn_require_role(array['super_admin']) au
  join team_merges tm on true
  join teams t on t.id = tm.merged_team_id
  left join users u on u.id = tm.merged_by
  order by tm.created_at desc
$$;

grant execute on function fn_super_team_merges() to authenticated;

-- ---------------------------------------------------------------------------
-- Re-assert the 025 lockdown for everything created/replaced above.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on function fn_login(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
