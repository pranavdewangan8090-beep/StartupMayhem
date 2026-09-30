-- Allows many simultaneous logins with the same team/admin/super_admin
-- credentials — logging in on a second (or third, ...) screen no longer
-- kicks out any earlier session.
--
-- Mechanism: fn_login used to bump session_version on every successful
-- login and sign the new token with that bumped value; fn_auth_user()
-- requires the JWT's 'sv' claim to match the CURRENT users.session_version,
-- so every earlier token (still carrying the pre-bump value) instantly
-- stopped resolving. This just stops the bump on login — every session
-- signs its token with whatever session_version already is, so any number
-- of tokens issued at different times all stay valid together.
--
-- Deliberately NOT changed: fn_super_reset_password still bumps
-- session_version, so resetting a password still force-logs-out every
-- device using that account (confirmed as wanted — a compromised/changed
-- password should still kill old sessions, this is a different mechanism
-- from "logging in again kicks the previous screen"). fn_super_deactivate_team
-- still force-logs-out via is_active, also unaffected.
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

  -- session_version is intentionally left untouched here — see file header.
  -- Every concurrent login signs its token with the SAME current value, so
  -- none of them invalidate each other.
  update users set last_login_at = now() where id = v_user.id;

  v_token := sign(
    json_build_object(
      'role', 'authenticated',
      'sub', v_user.id::text,
      'app_role', v_user.role,
      'team_id', v_user.team_id,
      'sv', v_user.session_version,
      'iat', extract(epoch from now())::int,
      'exp', extract(epoch from now() + interval '12 hours')::int
    ),
    fn_current_jwt_secret()
  );

  return jsonb_build_object('token', v_token, 'role', v_user.role, 'teamId', v_user.team_id);
end;
$$;

grant execute on function fn_login(text, text, text) to anon, authenticated;

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on function fn_login(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
