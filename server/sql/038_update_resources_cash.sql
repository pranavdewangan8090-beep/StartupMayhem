-- Updates the Starting Resources cards' Cash values per the source docx
-- (Startup_Mayhem_2.0_Starting_Cards) — serial number : new cash in ₹M:
--   1:5  2:12  3:6  4:7  5:9  6:7  7:13  8:5  9:6  10:5
--   11:4 12:9  13:8 14:10 15:5 16:7 17:9 18:7 19:11 20:8
-- Converted to lakhs (start_cash_l = ₹M * 10) below.
--
-- Two parts, both needed:
--  1. Update the identity_cards TEMPLATE rows, so every future team
--     creation / R1 replace picks up the new values.
--  2. Update every currently ACTIVE team's live cash_l to match, since
--     the game was just reset for final play — without this, teams would
--     be sitting on the OLD cash figures until a future reset happened to
--     redraw the same card, which isn't the intent here.
-- Untouched: which resources card each team currently holds, every other
-- resource, every other identity card, hands, credentials.

update identity_cards set start_cash_l = v.new_cash_l
from (values
  (1, 50), (2, 120), (3, 60), (4, 70), (5, 90),
  (6, 70), (7, 130), (8, 50), (9, 60), (10, 50),
  (11, 40), (12, 90), (13, 80), (14, 100), (15, 50),
  (16, 70), (17, 90), (18, 70), (19, 110), (20, 80)
) as v(number, new_cash_l)
where identity_cards.category = 'resources' and identity_cards.number = v.number;

update teams set cash_l = ic.start_cash_l
from identity_cards ic
where teams.resources_card_id = ic.id and teams.is_active;

notify pgrst, 'reload schema';
