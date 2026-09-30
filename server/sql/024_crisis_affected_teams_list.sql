-- fn_crisis_public gains per-tier team lists (which teams got Hit Hard, Hit,
-- Unaffected, Gains) alongside the caller's own tier/effect — not sensitive
-- (no resource numbers, just team codes), so every player can see who else
-- was affected by a crisis, not just their own outcome.

drop function if exists fn_crisis_public();
create function fn_crisis_public()
returns table (
  crisis_id int, number smallint, title text, description text, tier text, applied jsonb,
  hit_hard_teams text[], hit_teams text[], unaffected_teams text[], gains_teams text[]
)
language sql security definer stable
set search_path = public, pg_temp
as $$
  select c.id, c.number, c.title, c.description, cte.tier, cte.applied - 'decision_points',
    array(select t.team_code from crisis_team_effects e join teams t on t.id = e.team_id
          where e.crisis_id = c.id and e.tier = 'hit_hard' order by t.team_code),
    array(select t.team_code from crisis_team_effects e join teams t on t.id = e.team_id
          where e.crisis_id = c.id and e.tier = 'hit' order by t.team_code),
    array(select t.team_code from crisis_team_effects e join teams t on t.id = e.team_id
          where e.crisis_id = c.id and e.tier = 'unaffected' order by t.team_code),
    array(select t.team_code from crisis_team_effects e join teams t on t.id = e.team_id
          where e.crisis_id = c.id and e.tier = 'gains' order by t.team_code)
  from fn_require_role(array['player','admin','super_admin']) au
  join crises c on c.is_triggered
  left join crisis_team_effects cte on cte.crisis_id = c.id and cte.team_id = au.team_id
  order by c.number
$$;

grant execute on function fn_crisis_public() to authenticated;
revoke execute on function fn_crisis_public() from anon;
