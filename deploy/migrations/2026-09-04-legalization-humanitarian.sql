-- Гуманітарні підстави перебування (рішення власника 03.09.2026). Усі дають і побут,
-- і працю без zezwolenia, без привʼязки до роботодавця. Дзеркало
-- services/legalizationCatalog.ts (DOCUMENT_TYPE_SEED). Ідемпотентно.
INSERT INTO document_types (code, name, required, has_expiry, sort_order, icon, category, grants_stay, grants_work, requires_employer_match, default_validity_days, renewal_lead_days, applies_to_nationalities, is_system) VALUES
  ('humanitarian_visa',      'Wiza humanitarna (obywatele Białorusi)',      false, true, 181, 'residence_card', 'stay', true, true, false, null, 30, '["belarus"]'::jsonb, true),
  ('refugee_status',         'Status uchodźcy (karta pobytu)',              false, true, 182, 'residence_card', 'stay', true, true, false, null, 60, '["non_eu"]'::jsonb,  true),
  ('subsidiary_protection',  'Ochrona uzupełniająca (karta pobytu)',        false, true, 183, 'residence_card', 'stay', true, true, false, null, 60, '["non_eu"]'::jsonb,  true),
  ('humanitarian_stay',      'Zgoda na pobyt ze względów humanitarnych',    false, true, 184, 'residence_card', 'stay', true, true, false, null, 60, '["non_eu"]'::jsonb,  true),
  ('tolerated_stay',         'Zgoda na pobyt tolerowany',                   false, true, 185, 'residence_card', 'stay', true, true, false, null, 60, '["non_eu"]'::jsonb,  true),
  ('eu_family_member_card',  'Karta pobytu członka rodziny obywatela UE',   false, true, 186, 'residence_card', 'stay', true, true, false, null, 60, '["non_eu"]'::jsonb,  true)
ON CONFLICT (code) DO NOTHING;
