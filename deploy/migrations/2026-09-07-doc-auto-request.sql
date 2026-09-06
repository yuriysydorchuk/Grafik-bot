-- Модуль «Задачі»: автозапит документів у працівника (рішення власника 06.09.2026).
-- Система сама просить документ перед кінцем строку і нагадує; офіс отримує задачу лише
-- перевірити файл або звʼязатись, якщо людина мовчить. Типи, які працівник надсилає сам —
-- прапорець self_service (badania/sanepid/powiadomienie/oświadczenie/zezwolenie — оформляє офіс).
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS self_service boolean NOT NULL DEFAULT false;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS request_remind_count integer NOT NULL DEFAULT 0;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS request_reminded_at timestamp;

UPDATE document_types SET self_service = true WHERE code IN (
  'passport', 'trc', 'karta_stalego_pobytu', 'rezydent_ue', 'eu_family_member_card', 'refugee_status', 'subsidiary_protection',
  'humanitarian_stay', 'humanitarian_visa', 'tolerated_stay', 'visa_c', 'visa_d', 'visa_free', 'id_card_eu', 'id_card_pl', 'karta_polaka',
  'student_cert', 'diploma', 'stay_case_certificate', 'status_ukr'
);
