-- Bug found by test/roundMechanics.test.js's merge test: fn_super_merge_teams
-- re-points both original teams' team_action_cards rows to the new merged
-- team in one UPDATE. If team A and team B happened to have been dealt the
-- SAME specific card (entirely possible now — up to 3 different teams can
-- hold any one card under the 027 supply cap, it's not "unique per game"),
-- the merged team ends up with two team_action_cards rows sharing
-- (team_id, action_card_id) with source='r2', which violated
-- team_action_cards_r2_unique and made the merge fail outright.
--
-- That index's original purpose was to stop a team requesting the same
-- card twice through the old R2 "request a card" flow (fn_r2_request_card,
-- dropped in 019_auto_allot_action_cards.sql) — a team could never legally
-- end up holding two copies of the same card back then. Cards are now
-- auto-issued (never requested) and, since 027, deliberately allowed to be
-- held by up to 3 different teams at once, so a merged team legitimately
-- holding two copies of the same card is a normal outcome, not a bug the
-- constraint should be preventing. The constraint is simply stale.
drop index if exists team_action_cards_r2_unique;

notify pgrst, 'reload schema';
