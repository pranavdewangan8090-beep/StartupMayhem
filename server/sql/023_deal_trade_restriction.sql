-- Deal cards may only be traded for another deal card — every other card
-- combination (action-for-action, action-for-special, special-for-special,
-- etc.) is still unrestricted. A deal card is meant to be played together
-- with a real partner team (fn_play_deal_card/fn_respond_deal_card); trading
-- it away for a non-deal card would let a team dodge that pairing mechanic.

create or replace function fn_admin_process_trade(
  p_team_a_id int, p_team_a_card_id uuid,
  p_team_b_id int, p_team_b_card_id uuid,
  p_money_team_id int, p_money_amount int,
  p_crisis_id int, p_request_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_card_a team_action_cards%rowtype;
  v_card_b team_action_cards%rowtype;
  v_category_a text;
  v_category_b text;
  v_payee_id int;
begin
  select user_id into v_actor from fn_require_role(array['admin','super_admin']);

  if exists (select 1 from trades where request_id = p_request_id) then
    raise exception 'DUPLICATE_REQUEST';
  end if;
  if not exists (select 1 from trade_feature_toggles where enabled) then
    raise exception 'TRADING_DISABLED';
  end if;
  if p_team_a_id = p_team_b_id then raise exception 'CANNOT_TRADE_SELF'; end if;
  if coalesce(p_money_amount, 0) < 0 then raise exception 'BAD_MONEY_AMOUNT'; end if;
  if coalesce(p_money_amount, 0) > 0 and p_money_team_id is null then
    raise exception 'MONEY_TEAM_INVALID';
  end if;
  if p_money_team_id is not null and p_money_team_id not in (p_team_a_id, p_team_b_id) then
    raise exception 'MONEY_TEAM_INVALID';
  end if;

  -- lock both card rows in a fixed order (by uuid text) to avoid deadlocks
  if p_team_a_card_id::text < p_team_b_card_id::text then
    select * into v_card_a from team_action_cards where id = p_team_a_card_id for update;
    select * into v_card_b from team_action_cards where id = p_team_b_card_id for update;
  else
    select * into v_card_b from team_action_cards where id = p_team_b_card_id for update;
    select * into v_card_a from team_action_cards where id = p_team_a_card_id for update;
  end if;

  if v_card_a.id is null or v_card_a.team_id <> p_team_a_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_card_b.id is null or v_card_b.team_id <> p_team_b_id then raise exception 'CARD_NOT_FOUND'; end if;
  if v_card_a.status <> 'held' or v_card_b.status <> 'held' then raise exception 'CARD_NOT_AVAILABLE'; end if;

  select category into v_category_a from action_cards where id = v_card_a.action_card_id;
  select category into v_category_b from action_cards where id = v_card_b.action_card_id;
  if (v_category_a = 'deal') <> (v_category_b = 'deal') then
    raise exception 'DEAL_TRADES_ONLY_WITH_DEAL';
  end if;

  if coalesce(p_money_amount, 0) > 0 then
    -- lock both team rows in a fixed order to avoid deadlocking against a
    -- concurrent trade/adjustment touching the same two teams
    perform 1 from teams where id = least(p_team_a_id, p_team_b_id) for update;
    perform 1 from teams where id = greatest(p_team_a_id, p_team_b_id) for update;

    v_payee_id := case when p_money_team_id = p_team_a_id then p_team_b_id else p_team_a_id end;

    if (select cash_l from teams where id = p_money_team_id) < p_money_amount then
      raise exception 'INSUFFICIENT_CASH';
    end if;
    update teams set cash_l = cash_l - p_money_amount where id = p_money_team_id;
    update teams set cash_l = cash_l + p_money_amount where id = v_payee_id;
  end if;

  update team_action_cards set team_id = p_team_b_id, source = 'admin' where id = p_team_a_card_id;
  update team_action_cards set team_id = p_team_a_id, source = 'admin' where id = p_team_b_card_id;

  insert into trades (crisis_id, team_a_id, team_a_card_id, team_b_id, team_b_card_id, money_team_id, money_amount, processed_by, request_id)
  values (p_crisis_id, p_team_a_id, p_team_a_card_id, p_team_b_id, p_team_b_card_id, p_money_team_id, coalesce(p_money_amount, 0), v_actor, p_request_id);

  if p_crisis_id is not null then
    update crisis_affected_teams
    set status = 'traded', updated_at = now(), updated_by = v_actor
    where crisis_id = p_crisis_id and status = 'pending' and (
      (team_id = p_team_a_id and v_card_b.action_card_id in (select action_card_id from crisis_useful_cards where crisis_id = p_crisis_id))
      or
      (team_id = p_team_b_id and v_card_a.action_card_id in (select action_card_id from crisis_useful_cards where crisis_id = p_crisis_id))
    );
  end if;

  return jsonb_build_object(
    'teamACardId', p_team_a_card_id, 'teamBCardId', p_team_b_card_id,
    'teamAId', p_team_a_id, 'teamBId', p_team_b_id
  );
end;
$$;

grant execute on function fn_admin_process_trade(int, uuid, int, uuid, int, int, int, uuid) to authenticated;
revoke execute on function fn_admin_process_trade(int, uuid, int, uuid, int, int, int, uuid) from anon;
