-- Postgres functions: every multi-step / concurrency-sensitive operation in the
-- game runs as ONE of these, inside ONE transaction, with the team row(s) locked
-- (`select ... for update`). The Node server calls these instead of doing
-- multi-statement writes itself, so two admins or two teams acting at once can
-- never race each other or leave the game in a half-updated state.
--
-- Idempotency: every function takes a `p_request_id uuid`. Callers generate it
-- client-side (or the route generates one per submit) and retry-safe: a repeat
-- call with the same request_id raises 'DUPLICATE_REQUEST' rather than applying
-- twice (double-tap / replay protection).

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
-- R1: identity card replacement (max 3 per team)
-- ---------------------------------------------------------------------------
create or replace function fn_replace_identity_card(
  p_team_id int, p_category text, p_request_id uuid
) returns identity_cards
language plpgsql as $$
declare
  v_team teams%rowtype;
  v_old_id int;
  v_new identity_cards%rowtype;
  v_col text;
begin
  if exists (select 1 from card_replacements where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;

  select * into v_team from teams where id = p_team_id for update;
  if v_team.id is null then raise exception 'TEAM_NOT_FOUND'; end if;

  if (select r1_replace_open from game_state where id = 1) is not true then
    raise exception 'REPLACEMENTS_CLOSED';
  end if;
  if v_team.replacements_used >= 3 then
    raise exception 'REPLACEMENT_LIMIT_REACHED';
  end if;

  v_col := p_category || '_card_id';
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

  insert into card_replacements (team_id, category, old_card_id, new_card_id, request_id)
  values (p_team_id, p_category, v_old_id, v_new.id, p_request_id);

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

  insert into card_plays (team_action_card_id, action_card_id, team_id, status,
                           self_applied, request_id, resolved_at)
  values (p_team_action_card_id, v_card.id, p_team_id, 'applied', v_after, p_request_id, now());

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

  insert into card_plays (team_action_card_id, action_card_id, team_id, other_team_id, status,
                           self_applied, other_applied, request_id, resolved_at)
  values (p_team_action_card_id, v_card.id, p_team_id, p_target_team_id, 'applied',
          v_self_after, v_target_after, p_request_id, now());

  -- the attacked team must be told what happened and who did it
  insert into notifications (team_id, type, title, body)
  values (p_target_team_id, 'attacked',
          'You were attacked: ' || v_card.name,
          'Team ' || (select team_code from teams where id = p_team_id) ||
          ' played "' || v_card.name || '" on you. ' || v_card.effect_text);

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

  insert into notifications (team_id, type, title, body)
  values (p_partner_team_id, 'deal_offer',
          'Deal offer: ' || v_card.name,
          'Team ' || (select team_code from teams where id = p_team_id) ||
          ' proposes "' || v_card.name || '". ' || v_card.effect_text);

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
  if exists (select 1 from resource_adjustments where request_id = p_request_id)
     or exists (select 1 from card_plays where request_id = p_request_id and id <> p_card_play_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;

  select * into v_play from card_plays where id = p_card_play_id for update;
  if v_play.id is null or v_play.other_team_id <> p_partner_team_id then raise exception 'DEAL_NOT_FOUND'; end if;
  if v_play.status <> 'pending' then raise exception 'DEAL_ALREADY_RESOLVED'; end if;

  select * into v_card from action_cards where id = v_play.action_card_id;

  if not p_accept then
    update card_plays set status = 'rejected', resolved_at = now() where id = p_card_play_id;
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
  update card_plays set status = 'applied', self_applied = v_initiator_after,
                        other_applied = v_partner_after, resolved_at = now()
  where id = p_card_play_id;

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
  if exists (select 1 from market_listings where id <> p_listing_id and request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;

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

  insert into notifications (team_id, type, title, body)
  values (v_listing.seller_team_id, 'trade_offer', 'New trade offer on your listing', '');

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
  if exists (select 1 from trade_offers where id <> p_offer_id and request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;

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

  insert into notifications (team_id, type, title, body)
  values (v_offer.buyer_team_id, 'trade_accepted', 'Your trade offer was accepted', '');

  return jsonb_build_object('accepted', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin / Super Admin: resource and decision-point adjustments (deltas + audit)
-- ---------------------------------------------------------------------------
create or replace function fn_admin_adjust_resources(
  p_team_id int, p_actor_user_id uuid,
  p_d_cash_l int, p_d_customers int, p_d_reputation int, p_d_innovation int,
  p_reason text, p_request_id uuid
) returns jsonb
language plpgsql as $$
declare
  v_team teams%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_c record;
begin
  if p_request_id is not null and exists (select 1 from resource_adjustments where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;

  select * into v_team from teams where id = p_team_id for update;
  if v_team.id is null then raise exception 'TEAM_NOT_FOUND'; end if;
  v_before := fn_team_snapshot(p_team_id);

  v_c := fn_clamp_team(
    v_team.cash_l + p_d_cash_l, v_team.customers + p_d_customers,
    v_team.reputation + p_d_reputation, v_team.innovation + p_d_innovation);

  update teams set cash_l=v_c.f1, customers=v_c.f2, reputation=v_c.f3, innovation=v_c.f4
  where id = p_team_id;

  v_after := fn_team_snapshot(p_team_id);

  insert into resource_adjustments (team_id, actor_user_id, source, delta, applied, before, after, reason, request_id)
  values (p_team_id, p_actor_user_id, 'admin',
          jsonb_build_object('cash_l', p_d_cash_l, 'customers', p_d_customers,
                              'reputation', p_d_reputation, 'innovation', p_d_innovation),
          jsonb_build_object(
            'cash_l', (v_after->>'cash_l')::int - (v_before->>'cash_l')::int,
            'customers', (v_after->>'customers')::int - (v_before->>'customers')::int,
            'reputation', (v_after->>'reputation')::int - (v_before->>'reputation')::int,
            'innovation', (v_after->>'innovation')::int - (v_before->>'innovation')::int
          ), v_before, v_after, coalesce(p_reason, ''), p_request_id);

  return jsonb_build_object('before', v_before, 'after', v_after);
end;
$$;

create or replace function fn_admin_adjust_decision_points(
  p_team_id int, p_actor_user_id uuid, p_round smallint, p_delta smallint, p_note text, p_request_id uuid
) returns decision_points
language plpgsql as $$
declare
  v_row decision_points%rowtype;
begin
  if exists (select 1 from decision_points where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if not exists (select 1 from teams where id = p_team_id) then raise exception 'TEAM_NOT_FOUND'; end if;

  insert into decision_points (team_id, round, delta, actor_user_id, note, request_id)
  values (p_team_id, p_round, p_delta, p_actor_user_id, coalesce(p_note,''), p_request_id)
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Super Admin: trigger a random mayhem (does not repeat one already triggered
-- while any un-triggered mayhem remains)
-- ---------------------------------------------------------------------------
create or replace function fn_trigger_mayhem(p_actor_user_id uuid, p_request_id uuid) returns mayhem_events
language plpgsql as $$
declare
  v_mayhem_id int;
  v_row mayhem_events%rowtype;
begin
  if exists (select 1 from mayhem_events where triggered_by = p_actor_user_id and triggered_at > now() - interval '2 seconds') then
    raise exception 'TOO_FAST';
  end if;

  select id into v_mayhem_id from mayhems
  where is_active and id not in (select mayhem_id from mayhem_events)
  order by random() limit 1;

  if v_mayhem_id is null then
    select id into v_mayhem_id from mayhems where is_active order by random() limit 1;
  end if;
  if v_mayhem_id is null then raise exception 'NO_MAYHEMS_CONFIGURED'; end if;

  insert into mayhem_events (mayhem_id, triggered_by) values (v_mayhem_id, p_actor_user_id)
  returning * into v_row;

  update game_state set current_mayhem_event_id = v_row.id, updated_at = now() where id = 1;

  return v_row;
end;
$$;
