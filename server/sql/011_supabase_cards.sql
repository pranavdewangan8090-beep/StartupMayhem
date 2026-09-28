-- First real vertical slice on the Supabase-direct path: the player identity
-- cards page (view + replace). Template for every other route to follow.
--
-- teams stays fully locked down (no RLS policy, no grants) rather than
-- getting an "own row" policy, because RLS is row-level only — a policy that
-- let a player SELECT their own team row would also let them query hidden
-- columns like decision_points via PostgREST's ?select=. Instead, curated
-- SECURITY DEFINER functions expose exactly the columns a player should see,
-- deriving the caller's team_id from fn_auth_user() rather than trusting a
-- client-supplied id — same pattern as fn_login/fn_auth_user in 010.

create or replace function fn_player_cards()
returns table (
  market_id int, market_title text, market_tagline text, market_desc text, market_tags text[],
  customer_id int, customer_title text, customer_tagline text, customer_desc text, customer_tags text[],
  mission_id int, mission_title text, mission_tagline text, mission_desc text, mission_tags text[], bonus_points smallint,
  resources_id int, resources_title text, resources_tagline text, resources_desc text, resources_tags text[],
  start_cash_l int, start_customers int, start_reputation smallint, start_innovation smallint,
  replacements_used smallint, cash_l int, customers int, reputation smallint, innovation smallint
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select
    mk.id, mk.title, mk.tagline, mk.description, mk.event_tags,
    cu.id, cu.title, cu.tagline, cu.description, cu.event_tags,
    ms.id, ms.title, ms.tagline, ms.description, ms.event_tags, ms.bonus_points,
    rc.id, rc.title, rc.tagline, rc.description, rc.event_tags,
    rc.start_cash_l, rc.start_customers, rc.start_reputation, rc.start_innovation,
    t.replacements_used, t.cash_l, t.customers, t.reputation, t.innovation
  from fn_auth_user() au
  join teams t on t.id = au.team_id
  join identity_cards mk on mk.id = t.market_card_id
  join identity_cards cu on cu.id = t.customer_card_id
  join identity_cards ms on ms.id = t.mission_card_id
  join identity_cards rc on rc.id = t.resources_card_id
  where au.app_role = 'player'
$$;

grant execute on function fn_player_cards() to authenticated;
revoke execute on function fn_player_cards() from anon;

-- fn_replace_identity_card no longer trusts a caller-supplied p_team_id (there
-- is no Express layer left to have validated req.user.teamId against the
-- session) — it derives the acting team from fn_auth_user() itself, and the
-- unused p_request_id parameter (this function never had a dedup check;
-- REPLACEMENT_LIMIT_REACHED already bounds it to 3 calls) is dropped.
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

  -- infinite supply: pick any other card of the same category at random
  select * into v_new from identity_cards
  where category = p_category and id <> v_old_id
  order by random() limit 1;

  update teams set
    market_card_id    = case when p_category = 'market'    then v_new.id else market_card_id end,
    customer_card_id  = case when p_category = 'customer'  then v_new.id else customer_card_id end,
    mission_card_id   = case when p_category = 'mission'   then v_new.id else mission_card_id end,
    resources_card_id = case when p_category = 'resources' then v_new.id else resources_card_id end,
    replacements_used = replacements_used + 1,
    -- a new Starting Resources card resets the team's live resources to its printed values
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
revoke execute on function fn_replace_identity_card(text) from anon;
