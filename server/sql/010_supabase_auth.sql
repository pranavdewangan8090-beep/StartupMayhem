-- Custom auth for calling Supabase directly from the browser (no Express
-- server in between). Login stays exactly as it is today — team code / admin
-- ID / super_admin ID + password — verified with pgcrypto against the same
-- password_hash column, no Supabase Auth / GoTrue user table involved.
--
-- fn_login mints a JWT signed with this project's own JWT secret (via
-- pgjwt), so PostgREST accepts it on every later request exactly as if it
-- came from Supabase Auth: it switches the DB role to 'authenticated' and
-- exposes the payload as request.jwt.claims, which fn_auth_user() reads.
--
-- The secret itself lives in _app_secrets, a table with RLS enabled and zero
-- policies — the public API (PostgREST, running as anon/authenticated) can
-- never read a row from it; only a SECURITY DEFINER function owned by the
-- table owner (which bypasses RLS by default) can.

create extension if not exists pgjwt;

-- pgjwt's sign() hardcodes a call to public.hmac(text,text,text), but Supabase
-- installs pgcrypto's hmac() into the `extensions` schema, not `public` — so
-- on any project created after that convention started, sign() fails with
-- "function public.hmac(text, text, text) does not exist" until this thin
-- forwarding wrapper exists.
create or replace function public.hmac(text, text, text) returns bytea
language sql immutable as $$ select extensions.hmac($1, $2, $3) $$;

create or replace function fn_current_jwt_secret() returns text
language sql security definer stable as $$
  select value from _app_secrets where key = 'jwt_secret'
$$;

-- A precomputed bcrypt hash of a random value, with no matching password —
-- used so a nonexistent login ID costs the same bcrypt.compare() time as a
-- real one, same anti-timing-leak trick the old Express route used.
create or replace function fn_login(p_role text, p_login_id text, p_password text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user users%rowtype;
  v_dummy_hash text := '$2a$10$C6UzMDM.H6dfI/f/IKcEeO0uJHZUjZ8yQaVh5xB.z3zH0m1oQ7YKO';
  v_hash_to_check text;
  v_ok boolean;
  v_sv int;
  v_token text;
begin
  if p_role not in ('player', 'admin', 'super_admin') then
    raise exception 'INVALID_CREDENTIALS';
  end if;

  select * into v_user from users where role = p_role and login_id = p_login_id;
  v_hash_to_check := coalesce(v_user.password_hash, v_dummy_hash);
  v_ok := (crypt(p_password, v_hash_to_check) = v_hash_to_check);

  if v_user.id is null or not v_user.is_active or not v_ok then
    raise exception 'INVALID_CREDENTIALS';
  end if;

  update users set session_version = session_version + 1, last_login_at = now()
  where id = v_user.id
  returning session_version into v_sv;

  v_token := sign(
    json_build_object(
      'role', 'authenticated',
      'sub', v_user.id::text,
      'app_role', v_user.role,
      'team_id', v_user.team_id,
      'sv', v_sv,
      'iat', extract(epoch from now())::int,
      'exp', extract(epoch from now() + interval '12 hours')::int
    ),
    fn_current_jwt_secret()
  );

  return jsonb_build_object('token', v_token, 'role', v_user.role, 'teamId', v_user.team_id);
end;
$$;

-- Every RLS policy and RPC function calls this to find out who's calling —
-- reads the verified JWT claims PostgREST already parsed for this request,
-- and re-checks session_version so an old token from before a re-login (or
-- an admin deactivating the account) stops working immediately, not just at
-- JWT expiry.
-- security definer so it can read the (otherwise fully locked-down) users
-- table on the caller's behalf without granting that table to anyone directly
create or replace function fn_auth_user()
returns table(user_id uuid, app_role text, team_id int)
language sql security definer stable as $$
  select u.id, u.role, u.team_id
  from users u
  where u.id = nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
    and u.session_version = coalesce((current_setting('request.jwt.claims', true)::json ->> 'sv')::int, -1)
    and u.is_active
$$;

-- Lock down the two auth-support tables/functions from direct client access
-- — only fn_login and fn_auth_user (both security definer) may touch
-- users/_app_secrets data; nothing calls either table's grants directly.
revoke all on _app_secrets from anon, authenticated;
revoke all on users from anon, authenticated;
grant execute on function fn_login(text, text, text) to anon, authenticated;
grant execute on function fn_auth_user() to authenticated;
revoke execute on function fn_auth_user() from anon;
