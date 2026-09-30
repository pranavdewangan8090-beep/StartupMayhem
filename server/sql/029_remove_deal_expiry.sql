-- Removes the 2-minute deal-offer auto-expiry added in
-- 027_round_mechanics.sql. A pending deal offer now stays pending until the
-- partner accepts/rejects or the proposer withdraws it — no time limit.
-- Everything else 027 added (paired deal cards: accepting applies AND
-- consumes BOTH teams' held deal cards, and proposing to a team with no
-- held deal card is refused outright) is unchanged.

drop function if exists fn_expire_stale_deal_plays();

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

  select * into v_play from card_plays where id = p_card_play_id for update;
  if v_play.id is null or v_play.other_team_id <> v_partner_team_id then raise exception 'DEAL_NOT_FOUND'; end if;
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

drop function if exists fn_deals_incoming();
create function fn_deals_incoming()
returns table (
  id bigint, created_at timestamptz, name text, description text, effect_text text, from_team_code text
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select cp.id, cp.created_at, ac.name, ac.description, ac.effect_text, t.team_code
  from fn_auth_user() au
  join card_plays cp on cp.other_team_id = au.team_id and cp.status = 'pending'
  join action_cards ac on ac.id = cp.action_card_id
  join teams t on t.id = cp.team_id
  where au.app_role = 'player'
  order by cp.created_at
$$;

grant execute on function fn_deals_incoming() to authenticated;

drop function if exists fn_deals_outgoing();
create function fn_deals_outgoing()
returns table (id bigint, created_at timestamptz, team_action_card_id uuid, name text, to_team_code text)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select cp.id, cp.created_at, cp.team_action_card_id, ac.name, t.team_code
  from fn_auth_user() au
  join card_plays cp on cp.team_id = au.team_id and cp.status = 'pending'
  join action_cards ac on ac.id = cp.action_card_id
  join teams t on t.id = cp.other_team_id
  where au.app_role = 'player'
  order by cp.created_at
$$;

grant execute on function fn_deals_outgoing() to authenticated;

drop function if exists fn_player_state();
create function fn_player_state()
returns table (
  r1_replace_open boolean, card_play_open boolean,
  action_card_count bigint, pending_deal_offers_in bigint,
  pending_deal_offers_out bigint, used_card_count bigint
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select gs.r1_replace_open, gs.card_play_open,
         (select count(*) from team_action_cards where team_id = au.team_id),
         (select count(*) from card_plays where other_team_id = au.team_id and status = 'pending'),
         (select count(*) from card_plays where team_id = au.team_id and status = 'pending'),
         (select count(*) from team_action_cards where team_id = au.team_id and status = 'used')
  from game_state gs, fn_auth_user() au
  where gs.id = 1 and au.app_role = 'player'
$$;

grant execute on function fn_player_state() to authenticated;

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on function fn_login(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
