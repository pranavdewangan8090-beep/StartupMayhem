-- Drops 6 Secret Mission cards from the pool: The Peacemaker, The
-- Dealmaker, The Power Broker, The Investor's Favourite, The Wildcard, The
-- Risk-Taker. "Drop" means never dealt to a team again (fn_super_add_team
-- at creation, fn_replace_identity_card on an R1 replace) — a team that
-- already holds one of these keeps it untouched. identity_cards has no
-- physical-print constraint (unlike action_cards' 3-copy cap), so this is
-- purely a "stop assigning" flag, not a supply limit.
--
-- identity_cards had no is_active column at all before this (only
-- action_cards did) — adding it here, defaulting every existing card to
-- true, matching that same precedent.

alter table identity_cards add column if not exists is_active boolean not null default true;

update identity_cards set is_active = false
where category = 'mission' and title in (
  'The Peacemaker', 'The Dealmaker', 'The Power Broker',
  'The Investor''s Favourite', 'The Wildcard', 'The Risk-Taker'
);

-- fn_super_add_team: every category's random pick now excludes inactive cards.
create or replace function fn_super_add_team(p_team_code text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_market identity_cards%rowtype;
  v_customer identity_cards%rowtype;
  v_mission identity_cards%rowtype;
  v_resources identity_cards%rowtype;
  v_team_id int;
  v_login_id text;
  v_password text;
begin
  perform 1 from fn_require_role(array['super_admin']);

  select * into v_market from identity_cards where category = 'market' and is_active order by random() limit 1;
  select * into v_customer from identity_cards where category = 'customer' and is_active order by random() limit 1;
  select * into v_mission from identity_cards where category = 'mission' and is_active order by random() limit 1;
  select * into v_resources from identity_cards where category = 'resources' and is_active order by random() limit 1;

  insert into teams (team_code, cash_l, customers, reputation, innovation,
    market_card_id, customer_card_id, mission_card_id, resources_card_id)
  values (p_team_code, v_resources.start_cash_l, v_resources.start_customers,
    v_resources.start_reputation, v_resources.start_innovation,
    v_market.id, v_customer.id, v_mission.id, v_resources.id)
  returning id into v_team_id;

  v_login_id := p_team_code || '-' || fn_random_suffix(4);
  v_password := fn_random_password();
  insert into users (role, login_id, password_hash, team_id)
  values ('player', v_login_id, crypt(v_password, gen_salt('bf')), v_team_id);

  perform fn_issue_starting_hand(v_team_id);

  return jsonb_build_object('teamId', v_team_id, 'teamCode', p_team_code, 'loginId', v_login_id, 'password', v_password);
end;
$$;

grant execute on function fn_super_add_team(text) to authenticated;

-- fn_replace_identity_card: an R1 replace also excludes inactive cards.
create or replace function fn_replace_identity_card(p_category text)
returns identity_cards
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id int;
  v_team teams%rowtype;
  v_old_id int;
  v_new identity_cards%rowtype;
begin
  select au.team_id into v_team_id from fn_auth_user() au where au.app_role = 'player';
  if v_team_id is null then raise exception 'NOT_AUTHENTICATED'; end if;

  select * into v_team from teams where id = v_team_id for update;
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
    when 'mission' then v_old_id := v_team.mission_card_id;
    when 'resources' then v_old_id := v_team.resources_card_id;
    else raise exception 'BAD_CATEGORY';
  end case;

  select * into v_new from identity_cards
  where category = p_category and id <> v_old_id and is_active
  order by random() limit 1;

  update teams set
    market_card_id    = case when p_category = 'market'    then v_new.id else market_card_id end,
    customer_card_id  = case when p_category = 'customer'  then v_new.id else customer_card_id end,
    mission_card_id   = case when p_category = 'mission'   then v_new.id else mission_card_id end,
    resources_card_id = case when p_category = 'resources' then v_new.id else resources_card_id end,
    replacements_used = replacements_used + 1,
    cash_l      = case when p_category = 'resources' then v_new.start_cash_l else cash_l end,
    customers   = case when p_category = 'resources' then v_new.start_customers else customers end,
    reputation  = case when p_category = 'resources' then v_new.start_reputation else reputation end,
    innovation  = case when p_category = 'resources' then v_new.start_innovation else innovation end
  where id = v_team_id;

  update game_state set updated_at = now() where id = 1;
  return v_new;
end;
$$;

grant execute on function fn_replace_identity_card(text) to authenticated;

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on function fn_login(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
