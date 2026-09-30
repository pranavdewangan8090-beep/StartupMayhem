-- Actually removes the 6 mission cards deactivated in 035 (and already
-- reassigned away from every team in 036), rather than just leaving them
-- as is_active=false. Safe now because no team references them any more
-- — teams.mission_card_id has no ON DELETE clause (defaults to RESTRICT),
-- so this would fail loudly instead of silently orphaning a team if that
-- weren't true.
delete from identity_cards
where category = 'mission' and title in (
  'The Peacemaker', 'The Dealmaker', 'The Power Broker',
  'The Investor''s Favourite', 'The Wildcard', 'The Risk-Taker'
);
