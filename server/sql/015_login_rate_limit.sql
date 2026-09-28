-- fn_login had no brute-force protection once Express's per-IP login
-- limiter went away with the server itself. This adds account-level
-- protection instead of IP-based: PostgREST doesn't reliably expose the
-- caller's real IP (proxy headers are client-suppliable), but the thing
-- actually worth protecting — a specific team/admin/super_admin's 8-char
-- random password — is identified by (role, login_id) regardless of IP, so
-- rate limiting the account directly is both simpler and harder to evade.

create table if not exists login_attempts (
  id bigserial primary key,
  role text not null,
  login_id text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists login_attempts_lookup on login_attempts (role, login_id, attempted_at);

alter table login_attempts enable row level security;
revoke all on login_attempts from anon, authenticated;

-- 8 failed attempts in 5 minutes locks the account out until the window
-- rolls forward — generous enough that a team fumbling their own password a
-- few times never gets stuck, hopeless for guessing a random 8-character one.
--
-- Unlike every other RPC in this app, a credential failure here is reported
-- by RETURNING jsonb('error', code) rather than RAISE EXCEPTION. That's
-- deliberate: PostgREST wraps each call in one transaction, so a RAISE that
-- propagates out rolls back everything the function did in this call —
-- including the very INSERT into login_attempts meant to survive the
-- failure. Returning normally lets that bookkeeping commit; the client
-- (AuthContext.login()) checks the result for an `error` field and throws
-- from there instead of relying on a PostgREST-level error.
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
  v_recent_failures int;
begin
  if p_role not in ('player', 'admin', 'super_admin') then
    return jsonb_build_object('error', 'INVALID_CREDENTIALS');
  end if;

  select count(*) into v_recent_failures from login_attempts
  where role = p_role and login_id = p_login_id and attempted_at > now() - interval '5 minutes';
  if v_recent_failures >= 8 then
    return jsonb_build_object('error', 'RATE_LIMITED');
  end if;

  select * into v_user from users where role = p_role and login_id = p_login_id;
  v_hash_to_check := coalesce(v_user.password_hash, v_dummy_hash);
  v_ok := (crypt(p_password, v_hash_to_check) = v_hash_to_check);

  if v_user.id is null or not v_user.is_active or not v_ok then
    insert into login_attempts (role, login_id) values (p_role, p_login_id);
    return jsonb_build_object('error', 'INVALID_CREDENTIALS');
  end if;

  -- a legitimate login clears this account's failure history instead of
  -- leaving it rate-limited after the owner gets back in
  delete from login_attempts where role = p_role and login_id = p_login_id;

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

grant execute on function fn_login(text, text, text) to anon, authenticated;
