-- Round 3: Market Mayhem — the 3 real events from the GM Guide, with each
-- Market identity card's tier for each event. Tier deltas encode the base
-- resource change for a team that just ACCEPTs while Hit hard/Hit/Gains;
-- fn_record_mayhem_response combines these with the chosen response.

insert into mayhem_events (number, title, story_text, effect_text, tags, tier_deltas) values
  (1,
   'Record monsoon floods paralyse India''s tech capital',
   'A physical city crisis. It tests whether teams can reach customers when roads, offices and the airport shut. Based on the Chennai 2015 and Bengaluru 2022 floods. Home-based businesses win, because people stuck indoors move online.',
   'Mainly takes Customers. Hit hard -40k, Hit -20k, Gains +20k.',
   '{urban,logistics}',
   '{"hit_hard":{"customers":-40000},"hit":{"customers":-20000},"unaffected":{},"gains":{"customers":20000}}'::jsonb),
  (2,
   'Startup bank collapses, payments freeze overnight',
   'A money crisis. It tests whether teams keep all their eggs in one basket. Based on the Yes Bank freeze (2020), the Silicon Valley Bank collapse (2023) and the funding winter. Sectors investors still trust come out ahead.',
   'Mainly takes Cash. Hit hard -₹2M, Hit -₹1M, Gains +₹1M.',
   '{finance}',
   '{"hit_hard":{"cash_l":-20},"hit":{"cash_l":-10},"unaffected":{},"gains":{"cash_l":10}}'::jsonb),
  (3,
   'Huge data leak triggers national privacy crackdown',
   'A trust crisis. It tests whether teams protect their users before it''s too late. Based on India''s 2025 data-protection rules, Meta''s EUR1.2 billion fine and the Equifax breach. Companies that sell security and compliance win.',
   'Mainly takes Reputation and Innovation. Hit hard -1 Rep & -1 Innovation, Hit -1 Innovation, Gains +20k Customers.',
   '{social}',
   '{"hit_hard":{"reputation":-1,"innovation":-1},"hit":{"innovation":-1},"unaffected":{},"gains":{"customers":20000}}'::jsonb);

-- ---------------------------------------------------------------------------
-- Event 1 tiers
-- ---------------------------------------------------------------------------
insert into market_tiers (mayhem_event_id, market_card_id, tier)
select (select id from mayhem_events where number = 1), ic.id, t.tier
from identity_cards ic
join (values
  ('Logistics Network','hit_hard'), ('Travel & Hospitality','hit_hard'), ('Manufacturing 4.0','hit_hard'), ('Insurance & InsurTech','hit_hard'),
  ('AgriTech Fields','hit'), ('GreenTech Grid','hit'), ('Mobility & Transport','hit'), ('PropTech Skyline','hit'), ('Retail & Grocery','hit'), ('Space & Deep Tech','hit'),
  ('FinTech Frontier','unaffected'), ('E-Commerce Highway','unaffected'), ('Creator Economy','unaffected'), ('Cybersecurity Vault','unaffected'), ('B2B SaaS Cloud','unaffected'), ('Social Impact & NGO-Tech','unaffected'),
  ('HealthTech Horizon','gains'), ('EdTech Ecosystem','gains'), ('GamingTech Arena','gains'), ('Media & Entertainment','gains')
) as t(title, tier) on t.title = ic.title
where ic.category = 'market';

-- ---------------------------------------------------------------------------
-- Event 2 tiers
-- ---------------------------------------------------------------------------
insert into market_tiers (mayhem_event_id, market_card_id, tier)
select (select id from mayhem_events where number = 2), ic.id, t.tier
from identity_cards ic
join (values
  ('FinTech Frontier','hit_hard'), ('B2B SaaS Cloud','hit_hard'), ('HealthTech Horizon','hit_hard'), ('Cybersecurity Vault','hit_hard'),
  ('EdTech Ecosystem','hit'), ('E-Commerce Highway','hit'), ('GamingTech Arena','hit'), ('Retail & Grocery','hit'), ('Media & Entertainment','hit'), ('Social Impact & NGO-Tech','hit'),
  ('AgriTech Fields','unaffected'), ('Logistics Network','unaffected'), ('Mobility & Transport','unaffected'), ('PropTech Skyline','unaffected'), ('Creator Economy','unaffected'), ('Travel & Hospitality','unaffected'), ('Insurance & InsurTech','unaffected'),
  ('GreenTech Grid','gains'), ('Space & Deep Tech','gains'), ('Manufacturing 4.0','gains')
) as t(title, tier) on t.title = ic.title
where ic.category = 'market';

-- ---------------------------------------------------------------------------
-- Event 3 tiers
-- ---------------------------------------------------------------------------
insert into market_tiers (mayhem_event_id, market_card_id, tier)
select (select id from mayhem_events where number = 3), ic.id, t.tier
from identity_cards ic
join (values
  ('EdTech Ecosystem','hit_hard'), ('GamingTech Arena','hit_hard'), ('Creator Economy','hit_hard'), ('Media & Entertainment','hit_hard'),
  ('HealthTech Horizon','hit'), ('E-Commerce Highway','hit'), ('Mobility & Transport','hit'), ('GreenTech Grid','hit'), ('Space & Deep Tech','hit'), ('Social Impact & NGO-Tech','hit'),
  ('FinTech Frontier','unaffected'), ('AgriTech Fields','unaffected'), ('Logistics Network','unaffected'), ('PropTech Skyline','unaffected'), ('Travel & Hospitality','unaffected'), ('Retail & Grocery','unaffected'), ('Manufacturing 4.0','unaffected'),
  ('Cybersecurity Vault','gains'), ('B2B SaaS Cloud','gains'), ('Insurance & InsurTech','gains')
) as t(title, tier) on t.title = ic.title
where ic.category = 'market';
