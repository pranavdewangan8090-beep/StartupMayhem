-- Postgres functions: every multi-step / concurrency-sensitive operation in the
-- game runs as ONE of these, inside ONE transaction, with the team row(s) locked
-- (`select ... for update`). The Node server calls these instead of doing
-- multi-statement writes itself, so two admins or two teams acting at once can
-- never race each other or leave the game in a half-updated state.
--
-- No history/log tables: state lives only on teams, mayhems and team_action_cards.
-- Duplicate-submit protection is kept only where a functional row already exists
-- to hold it (team_action_cards, card_plays, market_listings, trade_offers);
-- one-off admin actions (resource/points adjustments, identity replacements) are
-- applied directly with no dedup bookkeeping.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function fn_clamp_team(
  p_cash int, p_customers int, p_reputation int, p_innovation int,
  out f1 int, out f2 int, out f3 int, out f4 int
) language sql immutable as $$
  select greatest(p_cash, 0),
         greatest(p_customers, 0),
         least(greatest(p_reputation, 0), 5),
         least(greatest(p_innovation, 0), 10)
$$;

create or replace function fn_team_snapshot(p_team_id int) returns jsonb
language sql stable as $$
  select jsonb_build_object('cash_l', cash_l, 'customers', customers,
                             'reputation', reputation, 'innovation', innovation)
  from teams where id = p_team_id
$$;

-- ---------------------------------------------------------------------------
-- R1: identity card replacement (max 3 per team, enforced on teams row)
-- ---------------------------------------------------------------------------
create or replace function fn_replace_identity_card(
  p_team_id int, p_category text, p_request_id uuid
) returns identity_cards
language plpgsql as $$
declare
  v_team teams%rowtype;
  v_old_id int;
  v_new identity_cards%rowtype;
begin
  select * into v_team from teams where id = p_team_id for update;
  if v_team.id is null then raise exception 'TEAM_NOT_FOUND'; end if;

  if (select r1_replace_open from game_state where id = 1) is not true then
    raise exception 'REPLACEMENTS_CLOSED';
  end if;
  if v_team.replacements_used >= 3 then
    raise exception 'REPLACEMENT_LIMIT_REACHED';
  end if;

  case p_category
    when 'market' then v_old_id := v_team.market_card_id;
    when 'customer' then v_old_id := v_team.customer_card_id;
    when 'problem' then v_old_id := v_team.problem_card_id;
    when 'mission' then v_old_id := v_team.mission_card_id;
    when 'resources' then v_old_id := v_team.resources_card_id;
    else raise exception 'BAD_CATEGORY';
  end case;

  -- infinite supply: pick any other card of the same category at random
  select * into v_new from identity_cards
  where category = p_category and id <> v_old_id
  order by random() limit 1;

  update teams set
    market_card_id    = case when p_category = 'market'    then v_new.id else market_card_id end,
    customer_card_id  = case when p_category = 'customer'  then v_new.id else customer_card_id end,
    problem_card_id   = case when p_category = 'problem'   then v_new.id else problem_card_id end,
    mission_card_id   = case when p_category = 'mission'   then v_new.id else mission_card_id end,
    resources_card_id = case when p_category = 'resources' then v_new.id else resources_card_id end,
    replacements_used = replacements_used + 1,
    -- a new Starting Resources card resets the team's live resources to its printed values
    cash_l      = case when p_category = 'resources' then v_new.start_cash_l else cash_l end,
    customers   = case when p_category = 'resources' then v_new.start_customers else customers end,
    reputation  = case when p_category = 'resources' then v_new.start_reputation else reputation end,
    innovation  = case when p_category = 'resources' then v_new.start_innovation else innovation end
  where id = p_team_id;

  update game_state set updated_at = now() where id = 1;
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- R2: request an action card (max 4 per team, no duplicate card per team)
-- ---------------------------------------------------------------------------
create or replace function fn_r2_request_card(
  p_team_id int, p_action_card_id int, p_request_id uuid
) returns team_action_cards
language plpgsql as $$
declare
  v_count int;
  v_category text;
  v_row team_action_cards%rowtype;
begin
  if exists (select 1 from team_action_cards where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;

  perform 1 from teams where id = p_team_id for update;

  if (select r2_selection_open from game_state where id = 1) is not true then
    raise exception 'R2_CLOSED';
  end if;

  select count(*) into v_count from team_action_cards
  where team_id = p_team_id and source = 'r2';
  if v_count >= 4 then
    raise exception 'R2_LIMIT_REACHED';
  end if;

  if exists (select 1 from team_action_cards
             where team_id = p_team_id and action_card_id = p_action_card_id and source = 'r2') then
    raise exception 'ALREADY_HAVE_CARD';
  end if;

  -- one card per category: self_help, attack, deal, special (4 categories,
  -- 4 max cards — a team's R2 hand always ends up with exactly one of each)
  select category into v_category from action_cards where id = p_action_card_id;
  if exists (
    select 1 from team_action_cards tac
    join action_cards ac on ac.id = tac.action_card_id
    where tac.team_id = p_team_id and tac.source = 'r2' and ac.category = v_category
  ) then
    raise exception 'CATEGORY_ALREADY_TAKEN';
  end if;

  insert into team_action_cards (team_id, action_card_id, status, source, request_id)
  values (p_team_id, p_action_card_id, 'held', 'r2', p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Play a Self Help or Special/AI card: instant effect on the player's own team
-- ---------------------------------------------------------------------------
create or replace function fn_play_self_card(
  p_team_id int, p_team_action_card_id uuid, p_request_id uuid
) returns jsonb
language plpgsql as $$
declare
  v_tac team_action_cards%rowtype;
  v_card action_cards%rowtype;
  v_team teams%rowtype;
  v_clamped record;
  v_before jsonb;
  v_after jsonb;
begin
  if exists (select 1 from card_plays where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if (select card_play_open from game_state where id = 1) is not true then
    raise exception 'CARD_PLAY_CLOSED';
  end if;

  select * into v_tac from team_action_cards where id = p_team_action_card_id for update;
  if v_tac.id is null or v_tac.team_id <> p_team_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_tac.status <> 'held' then raise exception 'CARD_NOT_AVAILABLE'; end if;

  select * into v_card from action_cards where id = v_tac.action_card_id;
  if v_card.category not in ('self_help','special') then raise exception 'WRONG_CARD_TYPE'; end if;

  select * into v_team from teams where id = p_team_id for update;
  v_before := fn_team_snapshot(p_team_id);

  v_clamped := fn_clamp_team(
    v_team.cash_l + coalesce((v_card.self_effect->>'cash_l')::int,0),
    v_team.customers + coalesce((v_card.self_effect->>'customers')::int,0),
    v_team.reputation + coalesce((v_card.self_effect->>'reputation')::int,0),
    v_team.innovation + coalesce((v_card.self_effect->>'innovation')::int,0)
  );

  -- do not let a card's own cost push Cash below zero
  if v_team.cash_l + coalesce((v_card.self_effect->>'cash_l')::int,0) < 0 then
    raise exception 'INSUFFICIENT_CASH';
  end if;

  update teams set cash_l = v_clamped.f1, customers = v_clamped.f2,
                    reputation = v_clamped.f3, innovation = v_clamped.f4
  where id = p_team_id;

  v_after := fn_team_snapshot(p_team_id);

  update team_action_cards set status = 'used', used_at = now() where id = p_team_action_card_id;

  insert into card_plays (team_action_card_id, action_card_id, team_id, status, request_id)
  values (p_team_action_card_id, v_card.id, p_team_id, 'applied', p_request_id);

  return jsonb_build_object('before', v_before, 'after', v_after);
end;
$$;

-- ---------------------------------------------------------------------------
-- Play an Attack card: instant effect on self + a target team (single use)
-- ---------------------------------------------------------------------------
create or replace function fn_play_attack_card(
  p_team_id int, p_team_action_card_id uuid, p_target_team_id int, p_request_id uuid
) returns jsonb
language plpgsql as $$
declare
  v_tac team_action_cards%rowtype;
  v_card action_cards%rowtype;
  v_self teams%rowtype;
  v_target teams%rowtype;
  v_c record;
  v_self_after jsonb;
  v_target_after jsonb;
begin
  if exists (select 1 from card_plays where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if (select card_play_open from game_state where id = 1) is not true then
    raise exception 'CARD_PLAY_CLOSED';
  end if;
  if p_target_team_id = p_team_id then raise exception 'CANNOT_TARGET_SELF'; end if;

  select * into v_tac from team_action_cards where id = p_team_action_card_id for update;
  if v_tac.id is null or v_tac.team_id <> p_team_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_tac.status <> 'held' then raise exception 'CARD_NOT_AVAILABLE'; end if;

  select * into v_card from action_cards where id = v_tac.action_card_id;
  if v_card.category <> 'attack' then raise exception 'WRONG_CARD_TYPE'; end if;

  -- lock both teams in a fixed order (lower id first) to avoid deadlocks between
  -- two attacks that target each other at the same time
  if p_team_id < p_target_team_id then
    select * into v_self from teams where id = p_team_id for update;
    select * into v_target from teams where id = p_target_team_id for update;
  else
    select * into v_target from teams where id = p_target_team_id for update;
    select * into v_self from teams where id = p_team_id for update;
  end if;
  if v_target.id is null then raise exception 'TARGET_NOT_FOUND'; end if;

  if v_self.cash_l + coalesce((v_card.self_effect->>'cash_l')::int,0) < 0 then
    raise exception 'INSUFFICIENT_CASH';
  end if;

  v_c := fn_clamp_team(
    v_self.cash_l + coalesce((v_card.self_effect->>'cash_l')::int,0),
    v_self.customers + coalesce((v_card.self_effect->>'customers')::int,0),
    v_self.reputation + coalesce((v_card.self_effect->>'reputation')::int,0),
    v_self.innovation + coalesce((v_card.self_effect->>'innovation')::int,0));
  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = p_team_id;

  v_c := fn_clamp_team(
    v_target.cash_l + coalesce((v_card.target_effect->>'cash_l')::int,0),
    v_target.customers + coalesce((v_card.target_effect->>'customers')::int,0),
    v_target.reputation + coalesce((v_card.target_effect->>'reputation')::int,0),
    v_target.innovation + coalesce((v_card.target_effect->>'innovation')::int,0));
  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = p_target_team_id;

  v_self_after := fn_team_snapshot(p_team_id);
  v_target_after := fn_team_snapshot(p_target_team_id);

  update team_action_cards set status = 'used', used_at = now() where id = p_team_action_card_id;

  insert into card_plays (team_action_card_id, action_card_id, team_id, other_team_id, status, request_id)
  values (p_team_action_card_id, v_card.id, p_team_id, p_target_team_id, 'applied', p_request_id);

  return jsonb_build_object('self_after', v_self_after, 'target_after', v_target_after);
end;
$$;

-- ---------------------------------------------------------------------------
-- Play a Deal card: proposes a two-team pact. Locks the card (status='pending')
-- until the partner accepts or rejects. Not consumed if rejected.
-- ---------------------------------------------------------------------------
create or replace function fn_play_deal_card(
  p_team_id int, p_team_action_card_id uuid, p_partner_team_id int, p_request_id uuid
) returns card_plays
language plpgsql as $$
declare
  v_tac team_action_cards%rowtype;
  v_card action_cards%rowtype;
  v_row card_plays%rowtype;
begin
  if exists (select 1 from card_plays where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if (select card_play_open from game_state where id = 1) is not true then
    raise exception 'CARD_PLAY_CLOSED';
  end if;
  if p_partner_team_id = p_team_id then raise exception 'CANNOT_TARGET_SELF'; end if;
  if not exists (select 1 from teams where id = p_partner_team_id) then
    raise exception 'PARTNER_NOT_FOUND';
  end if;

  select * into v_tac from team_action_cards where id = p_team_action_card_id for update;
  if v_tac.id is null or v_tac.team_id <> p_team_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_tac.status <> 'held' then raise exception 'CARD_NOT_AVAILABLE'; end if;

  select * into v_card from action_cards where id = v_tac.action_card_id;
  if v_card.category <> 'deal' then raise exception 'WRONG_CARD_TYPE'; end if;

  update team_action_cards set status = 'pending' where id = p_team_action_card_id;

  insert into card_plays (team_action_card_id, action_card_id, team_id, other_team_id, status, request_id)
  values (p_team_action_card_id, v_card.id, p_team_id, p_partner_team_id, 'pending', p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function fn_respond_deal_card(
  p_partner_team_id int, p_card_play_id bigint, p_accept boolean, p_request_id uuid
) returns jsonb
language plpgsql as $$
declare
  v_play card_plays%rowtype;
  v_card action_cards%rowtype;
  v_initiator teams%rowtype;
  v_partner teams%rowtype;
  v_c record;
  v_initiator_after jsonb;
  v_partner_after jsonb;
begin
  select * into v_play from card_plays where id = p_card_play_id for update;
  if v_play.id is null or v_play.other_team_id <> p_partner_team_id then raise exception 'DEAL_NOT_FOUND'; end if;
  if v_play.status <> 'pending' then raise exception 'DEAL_ALREADY_RESOLVED'; end if;

  select * into v_card from action_cards where id = v_play.action_card_id;

  if not p_accept then
    update card_plays set status = 'rejected' where id = p_card_play_id;
    update team_action_cards set status = 'held' where id = v_play.team_action_card_id;
    return jsonb_build_object('accepted', false);
  end if;

  if v_play.team_id < p_partner_team_id then
    select * into v_initiator from teams where id = v_play.team_id for update;
    select * into v_partner from teams where id = p_partner_team_id for update;
  else
    select * into v_partner from teams where id = p_partner_team_id for update;
    select * into v_initiator from teams where id = v_play.team_id for update;
  end if;

  v_c := fn_clamp_team(
    v_initiator.cash_l + coalesce((v_card.self_effect->>'cash_l')::int,0),
    v_initiator.customers + coalesce((v_card.self_effect->>'customers')::int,0),
    v_initiator.reputation + coalesce((v_card.self_effect->>'reputation')::int,0),
    v_initiator.innovation + coalesce((v_card.self_effect->>'innovation')::int,0));
  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = v_play.team_id;

  v_c := fn_clamp_team(
    v_partner.cash_l + coalesce((v_card.partner_effect->>'cash_l')::int,0),
    v_partner.customers + coalesce((v_card.partner_effect->>'customers')::int,0),
    v_partner.reputation + coalesce((v_card.partner_effect->>'reputation')::int,0),
    v_partner.innovation + coalesce((v_card.partner_effect->>'innovation')::int,0));
  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = p_partner_team_id;

  v_initiator_after := fn_team_snapshot(v_play.team_id);
  v_partner_after := fn_team_snapshot(p_partner_team_id);

  update team_action_cards set status = 'used', used_at = now() where id = v_play.team_action_card_id;
  update card_plays set status = 'applied' where id = p_card_play_id;

  return jsonb_build_object('accepted', true, 'initiator_after', v_initiator_after, 'partner_after', v_partner_after);
end;
$$;

-- ---------------------------------------------------------------------------
-- Marketplace: 1 card for 1 card, no money
-- ---------------------------------------------------------------------------
create or replace function fn_list_card(
  p_team_id int, p_team_action_card_id uuid, p_request_id uuid
) returns market_listings
language plpgsql as $$
declare
  v_tac team_action_cards%rowtype;
  v_row market_listings%rowtype;
begin
  if exists (select 1 from market_listings where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if (select marketplace_open from game_state where id = 1) is not true then
    raise exception 'MARKETPLACE_CLOSED';
  end if;

  select * into v_tac from team_action_cards where id = p_team_action_card_id for update;
  if v_tac.id is null or v_tac.team_id <> p_team_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_tac.status <> 'held' then raise exception 'CARD_NOT_AVAILABLE'; end if;

  update team_action_cards set status = 'listed' where id = p_team_action_card_id;

  insert into market_listings (team_action_card_id, seller_team_id, request_id)
  values (p_team_action_card_id, p_team_id, p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function fn_unlist_card(
  p_team_id int, p_listing_id bigint, p_request_id uuid
) returns void
language plpgsql as $$
declare
  v_listing market_listings%rowtype;
begin
  select * into v_listing from market_listings where id = p_listing_id for update;
  if v_listing.id is null or v_listing.seller_team_id <> p_team_id then raise exception 'LISTING_NOT_FOUND'; end if;
  if v_listing.status <> 'active' then raise exception 'LISTING_NOT_ACTIVE'; end if;

  update market_listings set status = 'unlisted', closed_at = now() where id = p_listing_id;
  update team_action_cards set status = 'held' where id = v_listing.team_action_card_id;

  -- any pending offers on this listing are void; their offered cards unlock
  update trade_offers set status = 'void', resolved_at = now()
  where listing_id = p_listing_id and status = 'pending';
  update team_action_cards set status = 'held'
  where id in (select offered_card_id from trade_offers
               where listing_id = p_listing_id and status = 'void' and resolved_at = now());
end;
$$;

create or replace function fn_make_trade_offer(
  p_buyer_team_id int, p_listing_id bigint, p_offered_team_action_card_id uuid, p_request_id uuid
) returns trade_offers
language plpgsql as $$
declare
  v_listing market_listings%rowtype;
  v_offered team_action_cards%rowtype;
  v_row trade_offers%rowtype;
begin
  if exists (select 1 from trade_offers where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if (select marketplace_open from game_state where id = 1) is not true then
    raise exception 'MARKETPLACE_CLOSED';
  end if;

  select * into v_listing from market_listings where id = p_listing_id for update;
  if v_listing.id is null or v_listing.status <> 'active' then raise exception 'LISTING_NOT_ACTIVE'; end if;
  if v_listing.seller_team_id = p_buyer_team_id then raise exception 'CANNOT_TRADE_WITH_SELF'; end if;

  select * into v_offered from team_action_cards where id = p_offered_team_action_card_id for update;
  if v_offered.id is null or v_offered.team_id <> p_buyer_team_id then raise exception 'OFFERED_CARD_NOT_FOUND'; end if;
  if v_offered.status <> 'held' then raise exception 'OFFERED_CARD_NOT_AVAILABLE'; end if;

  update team_action_cards set status = 'pending' where id = p_offered_team_action_card_id;

  insert into trade_offers (listing_id, buyer_team_id, offered_card_id, request_id)
  values (p_listing_id, p_buyer_team_id, p_offered_team_action_card_id, p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function fn_respond_trade_offer(
  p_seller_team_id int, p_offer_id bigint, p_accept boolean, p_request_id uuid
) returns jsonb
language plpgsql as $$
declare
  v_offer trade_offers%rowtype;
  v_listing market_listings%rowtype;
  v_other_offer_id bigint;
begin
  select * into v_offer from trade_offers where id = p_offer_id for update;
  if v_offer.id is null then raise exception 'OFFER_NOT_FOUND'; end if;
  if v_offer.status <> 'pending' then raise exception 'OFFER_ALREADY_RESOLVED'; end if;

  select * into v_listing from market_listings where id = v_offer.listing_id for update;
  if v_listing.seller_team_id <> p_seller_team_id then raise exception 'NOT_YOUR_LISTING'; end if;
  if v_listing.status <> 'active' then raise exception 'LISTING_NOT_ACTIVE'; end if;

  if not p_accept then
    update trade_offers set status = 'rejected', resolved_at = now() where id = p_offer_id;
    update team_action_cards set status = 'held' where id = v_offer.offered_card_id;
    return jsonb_build_object('accepted', false);
  end if;

  -- swap ownership: the listed card goes to the buyer, the offered card goes to the seller
  update team_action_cards set team_id = v_offer.buyer_team_id, status = 'held', source = 'trade'
  where id = v_listing.team_action_card_id;
  update team_action_cards set team_id = p_seller_team_id, status = 'held', source = 'trade'
  where id = v_offer.offered_card_id;

  update market_listings set status = 'sold', closed_at = now() where id = v_listing.id;
  update trade_offers set status = 'accepted', resolved_at = now() where id = p_offer_id;

  -- every other pending offer on this listing is void; unlock their offered cards
  for v_other_offer_id in
    select id from trade_offers where listing_id = v_listing.id and status = 'pending'
  loop
    update trade_offers set status = 'void', resolved_at = now() where id = v_other_offer_id;
    update team_action_cards set status = 'held'
    where id = (select offered_card_id from trade_offers where id = v_other_offer_id);
  end loop;

  return jsonb_build_object('accepted', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin / Super Admin: resource and decision-point adjustments (direct, no log)
-- ---------------------------------------------------------------------------
create or replace function fn_admin_adjust_resources(
  p_team_id int,
  p_d_cash_l int, p_d_customers int, p_d_reputation int, p_d_innovation int
) returns jsonb
language plpgsql as $$
declare
  v_team teams%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_c record;
begin
  select * into v_team from teams where id = p_team_id for update;
  if v_team.id is null then raise exception 'TEAM_NOT_FOUND'; end if;
  v_before := fn_team_snapshot(p_team_id);

  v_c := fn_clamp_team(
    v_team.cash_l + p_d_cash_l, v_team.customers + p_d_customers,
    v_team.reputation + p_d_reputation, v_team.innovation + p_d_innovation);

  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = p_team_id;

  v_after := fn_team_snapshot(p_team_id);
  return jsonb_build_object('before', v_before, 'after', v_after);
end;
$$;

create or replace function fn_admin_adjust_decision_points(
  p_team_id int, p_delta int
) returns teams
language plpgsql as $$
declare
  v_row teams%rowtype;
begin
  update teams set decision_points = decision_points + p_delta
  where id = p_team_id
  returning * into v_row;
  if v_row.id is null then raise exception 'TEAM_NOT_FOUND'; end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Super Admin: trigger the next Market Mayhem event in sequence (1, 2, 3).
-- Raises NO_MORE_EVENTS once all three have run.
-- ---------------------------------------------------------------------------
create or replace function fn_trigger_mayhem_event(p_actor_user_id uuid) returns mayhem_events
language plpgsql as $$
declare
  v_row mayhem_events%rowtype;
begin
  select * into v_row from mayhem_events
  where not is_triggered
  order by number limit 1;
  if v_row.id is null then raise exception 'NO_MORE_EVENTS'; end if;

  update mayhem_events set is_triggered = true, triggered_at = now(), triggered_by = p_actor_user_id
  where id = v_row.id
  returning * into v_row;

  update game_state set current_mayhem_event_id = v_row.id, updated_at = now() where id = 1;

  return v_row;
end;
$$;

-- Safety-net floor for a Market Mayhem effect: a response can never take a
-- team below ₹1M Cash (10 lakhs), 20k Customers, 1 Reputation or 1 Innovation
-- — stricter than the general 0 floor used elsewhere in the game.
create or replace function fn_clamp_team_mayhem(
  p_cash int, p_customers int, p_reputation int, p_innovation int,
  out f1 int, out f2 int, out f3 int, out f4 int
) language sql immutable as $$
  select greatest(p_cash, 10),
         greatest(p_customers, 20000),
         least(greatest(p_reputation, 1), 5),
         least(greatest(p_innovation, 1), 10)
$$;

-- Admin/Super Admin record one team's chosen response (accept/spend/adapt/
-- partner) to the currently-triggered Market Mayhem event. The team's tier
-- is looked up from market_tiers via their Market identity card, combined
-- with the response per the GM Guide's response table, and applied directly
-- — players never submit this themselves.
create or replace function fn_record_mayhem_response(
  p_actor_user_id uuid, p_team_id int, p_mayhem_event_id int,
  p_response text, p_partner_team_id int, p_request_id uuid
) returns team_mayhem_responses
language plpgsql as $$
declare
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
  if p_response not in ('accept', 'spend', 'adapt', 'partner') then raise exception 'BAD_RESPONSE'; end if;

  select * into v_event from mayhem_events where id = p_mayhem_event_id;
  if v_event.id is null then raise exception 'EVENT_NOT_FOUND'; end if;

  select * into v_team from teams where id = p_team_id for update;
  if v_team.id is null then raise exception 'TEAM_NOT_FOUND'; end if;

  select tier into v_tier from market_tiers
  where mayhem_event_id = p_mayhem_event_id and market_card_id = v_team.market_card_id;
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
    v_d_cash := -10; -- cost: ₹1M
    if v_tier in ('unaffected', 'gains') then
      v_d_customers := 40000;
    end if;
    -- hit_hard/hit: loss cancelled — no further delta beyond the cost

  elsif p_response = 'adapt' then
    v_d_innovation := -2; -- cost: 2 Innovation
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
      v_d_customers := 20000; -- this team is the helper
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
  values (p_mayhem_event_id, p_team_id, v_tier, p_response,
          case when p_response = 'partner' and v_tier in ('hit_hard','hit') then p_partner_team_id else null end,
          jsonb_build_object('cash_l', v_d_cash, 'customers', v_d_customers, 'reputation', v_d_reputation, 'innovation', v_d_innovation),
          p_actor_user_id, p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;
