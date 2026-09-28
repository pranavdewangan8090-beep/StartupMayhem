-- Placeholder Round 3 crisis content — 2 crises with placeholder "useful
-- card" lists. Replace title/description/useful cards here once the real
-- crisis content is finalized (see server/sql/016_round3_crises.sql for the
-- schema notes). Affected teams are NOT seeded here — teams don't exist yet
-- at this point in the seed order (scripts/seedUsers.js runs after this) —
-- the Super Admin assigns affected teams per crisis from the Control Room
-- once teams exist (fn_super_set_crisis_affected_teams), or uses the
-- "randomly assign" convenience (fn_super_randomize_crisis_teams) for
-- placeholder testing.

insert into crises (number, title, description) values
  (1, '[PLACEHOLDER] Payment Gateway Outage',
   'A major payments provider goes down nationwide for 48 hours. Startups that can prove customer trust and reassure users fastest recover quickest — replace with the real crisis text.'),
  (2, '[PLACEHOLDER] Viral Misinformation Wave',
   'A trending post falsely claims a safety issue in your sector. Startups with strong PR/reputation tooling weather it; others take a hit — replace with the real crisis text.');

-- Placeholder "useful" action cards per crisis (protect an affected team
-- that holds/uses one of these — no resource change needed).
insert into crisis_useful_cards (crisis_id, action_card_id)
select (select id from crises where number = 1), ac.id
from action_cards ac where ac.name in ('PR Crisis Control', 'AI Cybersecurity Sentinel');

insert into crisis_useful_cards (crisis_id, action_card_id)
select (select id from crises where number = 2), ac.id
from action_cards ac where ac.name in ('Corporate Social Responsibility', 'Automated AI Support Agent');
