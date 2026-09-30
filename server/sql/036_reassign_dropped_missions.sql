-- One-time data fix following 035: every team still holding one of the 6
-- dropped Secret Mission cards gets reassigned a random ACTIVE mission
-- instead. Idempotent — once no team references an inactive mission,
-- re-running this is a no-op (the loop simply finds nothing to do).
do $$
declare
  v_team record;
  v_new_mission int;
begin
  for v_team in
    select t.id from teams t
    join identity_cards ic on ic.id = t.mission_card_id
    where ic.category = 'mission' and not ic.is_active
  loop
    select id into v_new_mission from identity_cards
    where category = 'mission' and is_active
    order by random() limit 1;

    update teams set mission_card_id = v_new_mission where id = v_team.id;
  end loop;
end $$;
