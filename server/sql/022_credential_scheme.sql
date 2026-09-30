-- New credential scheme, matching scripts/seedUsers.js's reset: team login
-- IDs get a random suffix decoupled from the public team_code (T07-K3F9,
-- not just T07 — guessing a team's public T-number no longer gets you
-- their login), and passwords become a simple 6-digit PIN (safe given
-- fn_login's per-account rate limit from 015_login_rate_limit.sql; far
-- faster to type on a phone than a mixed-case password). Applies here so
-- fn_super_add_team (ad-hoc team creation from the Manage Teams UI) and
-- fn_super_reset_password stay consistent with the bulk seed script.

create or replace function fn_random_suffix(p_len int) returns text
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := gen_random_bytes(p_len);
  v_out text := '';
  i int;
begin
  for i in 0..p_len - 1 loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
  end loop;
  return v_out;
end;
$$;

create or replace function fn_random_password() returns text
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_bytes bytea := gen_random_bytes(6);
  v_out text := '';
  i int;
begin
  for i in 0..5 loop
    v_out := v_out || (get_byte(v_bytes, i) % 10)::text;
  end loop;
  return v_out;
end;
$$;

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

  select * into v_market from identity_cards where category = 'market' order by random() limit 1;
  select * into v_customer from identity_cards where category = 'customer' order by random() limit 1;
  select * into v_mission from identity_cards where category = 'mission' order by random() limit 1;
  select * into v_resources from identity_cards where category = 'resources' order by random() limit 1;

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

  return jsonb_build_object('teamId', v_team_id, 'teamCode', p_team_code, 'loginId', v_login_id, 'password', v_password);
end;
$$;

grant execute on function fn_super_add_team(text) to authenticated;
revoke execute on function fn_super_add_team(text) from anon;
