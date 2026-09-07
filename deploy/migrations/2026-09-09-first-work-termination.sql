-- Перший робочий день, виповідзення, PKD фірми, тип ZUS ZWUA (08.09.2026).
-- first_work_date: авто з першої явки «present» у затвердженому тижні (services/firstWorkDate.ts),
--   графікова може вписати руками; від нього рахується powiadomienie UA (≤ 7 днів).
-- termination_date: запланована дата звільнення (виповідзення) — крон звільняє в цю дату.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS first_work_date date;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS termination_date date;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pkd text;

-- Тип документа «ZUS ZWUA (wyrejestrowanie)» — закриває задачу виреєстрування після звільнення.
INSERT INTO document_types (code, name, required, has_expiry, sort_order, icon, category, grants_stay, grants_work, requires_employer_match, default_validity_days, renewal_lead_days, applies_to_nationalities, is_system)
VALUES ('zus_zwua', 'ZUS ZWUA (wyrejestrowanie)', false, false, 500, 'decision', 'payroll', false, false, false, NULL, NULL, NULL, true)
ON CONFLICT (code) DO NOTHING;
