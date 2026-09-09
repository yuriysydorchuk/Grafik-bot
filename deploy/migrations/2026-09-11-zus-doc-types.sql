-- Типи підтверджень ZUS (нотатка власника «BOT - UPDATE», 10.09.2026): ZUA / ZZA / ZCNA /
-- ZUA chorobowe — категорія «Кадри/ЗП», без строку, лише файл + дата. Дзеркало
-- services/legalizationCatalog.ts (DOCUMENT_TYPE_SEED). Ідемпотентно.
INSERT INTO document_types (code, name, required, has_expiry, sort_order, icon, category, grants_stay, grants_work, requires_employer_match, default_validity_days, renewal_lead_days, applies_to_nationalities, is_system)
VALUES
  ('zus_zua',           'ZUS ZUA (zgłoszenie do ubezpieczeń)',            false, false, 510, 'decision', 'payroll', false, false, false, NULL, NULL, NULL, true),
  ('zus_zza',           'ZUS ZZA (zgłoszenie — tylko zdrowotne)',          false, false, 520, 'decision', 'payroll', false, false, false, NULL, NULL, NULL, true),
  ('zus_zcna',          'ZUS ZCNA (zgłoszenie członka rodziny)',           false, false, 530, 'decision', 'payroll', false, false, false, NULL, NULL, NULL, true),
  ('zus_zua_chorobowe', 'ZUS ZUA — dobrowolne chorobowe (potwierdzenie)',  false, false, 540, 'decision', 'payroll', false, false, false, NULL, NULL, NULL, true)
ON CONFLICT (code) DO NOTHING;
