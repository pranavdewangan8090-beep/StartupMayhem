-- PLACEHOLDER mayhem events, so R3 and the Super Admin "trigger mayhem" flow can be
-- built and tested end-to-end. Replace this file with your real mayhem list
-- (send it the same way you sent the cards and I'll regenerate this file).
--
-- Each mayhem must carry at least one tag from: finance, social, urban, logistics
-- (per the Starting Cards doc, Section "Event tags"). mayhem_protections lists which
-- Special/AI action cards shield a holding team from THIS mayhem — admins see this
-- list on the trigger screen and decide manually whether to apply it.

insert into mayhems (title, description, effect_text, tags) values
  ('Payment Gateway Outage',
   'A major national payment gateway goes down for six hours during peak checkout traffic.',
   'All FinTech-adjacent startups face a temporary trust hit: -1 Reputation unless the team shows a mitigation plan.',
   '{finance}'),
  ('Viral Backlash on Social Media',
   'A customer complaint thread about "startups like yours" goes viral overnight.',
   'Teams with a large social following take a Reputation hit: -1 Reputation, -20k Customers, unless they respond fast.',
   '{social}'),
  ('City Traffic Gridlock',
   'A week-long civic project blocks major roads in your city.',
   'Any startup relying on physical delivery or on-ground presence loses -20k Customers this round.',
   '{urban,logistics}'),
  ('Vendor Supply Shortage',
   'A key raw-material or cloud-hosting vendor cuts supply with no warning.',
   'Startups relying on that vendor face a cost shock: -₹1M Cash, unless they show an alternate plan.',
   '{logistics}');

-- Example protections: adjust these once the real mayhem-to-card mapping is confirmed.
insert into mayhem_protections (mayhem_id, action_card_id)
select m.id, a.id from mayhems m, action_cards a
where m.title = 'Payment Gateway Outage' and a.name = 'AI Cybersecurity Sentinel';

insert into mayhem_protections (mayhem_id, action_card_id)
select m.id, a.id from mayhems m, action_cards a
where m.title = 'Viral Backlash on Social Media' and a.name = 'Automated AI Support Agent';

insert into mayhem_protections (mayhem_id, action_card_id)
select m.id, a.id from mayhems m, action_cards a
where m.title = 'City Traffic Gridlock' and a.name = 'Autonomous Logistics Optimizer';

insert into mayhem_protections (mayhem_id, action_card_id)
select m.id, a.id from mayhems m, action_cards a
where m.title = 'Vendor Supply Shortage' and a.name = 'AI Market Intelligence Agent';
