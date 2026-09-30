-- Replaces the 2 placeholder crises with the 3 real Round 3 crises, their
-- per-tier resource deltas, and the full 20-card Market tier assignment for
-- each (every Market card appears in exactly one tier per crisis).
--
-- Descriptions below are short flavor text drafted to fit each title/tier
-- table — swap in the official crisis story text here if there's a
-- different canonical version.

delete from crisis_useful_cards where crisis_id in (select id from crises where number in (1, 2));
delete from crises where number in (1, 2);

insert into crises (number, title, description, tier_deltas) values
  (1, 'Build-Cost Crunch',
   'A sudden spike in infrastructure, hardware and hiring costs hits every startup at once. Manufacturing, logistics and physical-supply-chain plays feel it hardest; asset-light software and platform businesses ride it out, or even gain as costlier rivals struggle.',
   '{"hit_hard": {"cash_l": -20, "innovation": -2, "decision_points": -40},
     "hit": {"cash_l": -10, "innovation": -1, "decision_points": -20},
     "unaffected": {"decision_points": 0},
     "gains": {"cash_l": 10, "innovation": 1, "decision_points": 20}}'::jsonb),
  (2, 'Overtaken Overnight',
   'A well-funded competitor launches a near-identical product overnight. Consumer-attention and content-driven startups lose ground fast; businesses with durable, hard-to-copy moats barely notice — some even pick up the customers the copycat drove away.',
   '{"hit_hard": {"customers": -40000, "innovation": -2, "decision_points": -40},
     "hit": {"customers": -20000, "innovation": -1, "decision_points": -20},
     "unaffected": {"decision_points": 0},
     "gains": {"customers": 20000, "innovation": 1, "decision_points": 20}}'::jsonb),
  (3, 'Trust Meltdown',
   'A high-profile data or safety scandal shakes public trust across the sector. Startups handling sensitive personal data or vulnerable users take the biggest reputational hit; logistics- and finance-adjacent businesses that were quick to reassure customers actually gain trust.',
   '{"hit_hard": {"customers": -40000, "reputation": -1, "decision_points": -40},
     "hit": {"reputation": -1, "decision_points": -20},
     "unaffected": {"decision_points": 0},
     "gains": {"reputation": 1, "decision_points": 20}}'::jsonb);

-- ---------------------------------------------------------------------------
-- Crisis 1: Build-Cost Crunch
-- ---------------------------------------------------------------------------
insert into crisis_market_tiers (crisis_id, market_card_id, tier)
select (select id from crises where number = 1), ic.id, v.tier
from identity_cards ic
join (values
  ('Manufacturing 4.0', 'hit_hard'), ('Logistics Network', 'hit_hard'), ('AgriTech Fields', 'hit_hard'), ('E-Commerce Highway', 'hit_hard'),
  ('Insurance & InsurTech', 'hit'), ('Media & Entertainment', 'hit'), ('HealthTech Horizon', 'hit'), ('Social Impact & NGO-Tech', 'hit'),
  ('Travel & Hospitality', 'hit'), ('Mobility & Transport', 'hit'), ('PropTech Skyline', 'hit'), ('Retail & Grocery', 'hit'), ('Space & Deep Tech', 'hit'),
  ('FinTech Frontier', 'unaffected'), ('B2B SaaS Cloud', 'unaffected'), ('GamingTech Arena', 'unaffected'),
  ('EdTech Ecosystem', 'gains'), ('Creator Economy', 'gains'), ('GreenTech Grid', 'gains'), ('Cybersecurity Vault', 'gains')
) as v(title, tier) on v.title = ic.title
where ic.category = 'market';

-- ---------------------------------------------------------------------------
-- Crisis 2: Overtaken Overnight
-- ---------------------------------------------------------------------------
insert into crisis_market_tiers (crisis_id, market_card_id, tier)
select (select id from crises where number = 2), ic.id, v.tier
from identity_cards ic
join (values
  ('EdTech Ecosystem', 'hit_hard'), ('Media & Entertainment', 'hit_hard'), ('Creator Economy', 'hit_hard'), ('Insurance & InsurTech', 'hit_hard'),
  ('Logistics Network', 'hit'), ('AgriTech Fields', 'hit'), ('GreenTech Grid', 'hit'), ('Cybersecurity Vault', 'hit'),
  ('Mobility & Transport', 'hit'), ('Space & Deep Tech', 'hit'), ('FinTech Frontier', 'hit'), ('B2B SaaS Cloud', 'hit'), ('GamingTech Arena', 'hit'),
  ('Travel & Hospitality', 'unaffected'), ('PropTech Skyline', 'unaffected'), ('Retail & Grocery', 'unaffected'),
  ('E-Commerce Highway', 'gains'), ('Manufacturing 4.0', 'gains'), ('HealthTech Horizon', 'gains'), ('Social Impact & NGO-Tech', 'gains')
) as v(title, tier) on v.title = ic.title
where ic.category = 'market';

-- ---------------------------------------------------------------------------
-- Crisis 3: Trust Meltdown
-- ---------------------------------------------------------------------------
insert into crisis_market_tiers (crisis_id, market_card_id, tier)
select (select id from crises where number = 3), ic.id, v.tier
from identity_cards ic
join (values
  ('HealthTech Horizon', 'hit_hard'), ('Social Impact & NGO-Tech', 'hit_hard'), ('GreenTech Grid', 'hit_hard'), ('Cybersecurity Vault', 'hit_hard'),
  ('Manufacturing 4.0', 'hit'), ('E-Commerce Highway', 'hit'), ('EdTech Ecosystem', 'hit'), ('Creator Economy', 'hit'), ('Travel & Hospitality', 'hit'),
  ('PropTech Skyline', 'hit'), ('Retail & Grocery', 'hit'), ('FinTech Frontier', 'hit'), ('B2B SaaS Cloud', 'hit'), ('GamingTech Arena', 'hit'),
  ('Mobility & Transport', 'unaffected'), ('Space & Deep Tech', 'unaffected'),
  ('Logistics Network', 'gains'), ('AgriTech Fields', 'gains'), ('Insurance & InsurTech', 'gains'), ('Media & Entertainment', 'gains')
) as v(title, tier) on v.title = ic.title
where ic.category = 'market';

-- Sanity check: every crisis must cover all 20 Market cards exactly once.
do $$
declare v_bad record;
begin
  for v_bad in
    select c.number, count(*) as n
    from crises c join crisis_market_tiers cmt on cmt.crisis_id = c.id
    where c.number in (1, 2, 3)
    group by c.number
    having count(*) <> 20
  loop
    raise exception 'crisis % has % market tier rows, expected 20', v_bad.number, v_bad.n;
  end loop;
end $$;
