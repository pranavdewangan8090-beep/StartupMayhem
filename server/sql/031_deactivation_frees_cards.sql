-- Deactivating a team now returns its cards to the available pool for the
-- 3-copy cap, instead of a deactivated team's cards permanently occupying a
-- slot forever.
--
-- Why: 027's cap counts every team_action_cards row for a card, active or
-- not. With exactly 45 teams now seeded (see seedUsers.js) and 15 distinct
-- cards per category × 3 copies = 45, the printed supply is saturated
-- exactly — zero spare capacity for a 46th team, ever, with no way to
-- recover any. This makes "deactivate a team" the intended, deliberate way
-- to free up capacity: physically, deactivating a team is "they're out of
-- the game, hand back your card" — that card should become available for
-- a replacement team or a newly added one.
--
-- Known trade-off, not a bug: if team A (holding card X) is deactivated,
-- and its freed slot gets reissued to a new team D, then A is later
-- REACTIVATED, the database will show 3 other active teams already
-- holding card X plus A's original one — 4 "active" holders of a card
-- with only 3 physical copies. That's a real-world conflict (two teams
-- would show the same card on their phones) the organizers need to
-- resolve by hand (e.g. don't reissue a card whose team you might
-- reactivate, or trade it back) — the system can't know which physical
-- card is actually in whose hands.
create or replace function fn_issue_starting_hand(p_team_id int)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_category text;
  v_card_id int;
begin
  foreach v_category in array array['action', 'deal', 'special'] loop
    if not exists (
      select 1 from team_action_cards tac join action_cards ac on ac.id = tac.action_card_id
      where tac.team_id = p_team_id and ac.category = v_category
    ) then
      select ac.id into v_card_id
      from action_cards ac
      where ac.category = v_category and ac.is_active
        -- only cards held by currently ACTIVE teams count against the cap
        -- — a deactivated team's copy is treated as returned to the pool
        and (
          select count(*) from team_action_cards tac2
          join teams t2 on t2.id = tac2.team_id
          where tac2.action_card_id = ac.id and t2.is_active
        ) < 3
      order by random() limit 1;

      if v_card_id is null then
        raise exception 'NO_CARDS_AVAILABLE_IN_CATEGORY';
      end if;

      insert into team_action_cards (team_id, action_card_id, status, source)
      values (p_team_id, v_card_id, 'held', 'r2');
    end if;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
