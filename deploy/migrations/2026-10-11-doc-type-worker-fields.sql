-- 11.10.2026: які дані працівник вписує сам при завантаженні документа на /docs/:token
-- (document_types.worker_fields — список ключів number|validFrom|issuedAt|expiresAt|issuer,
-- усі обовʼязкові; NULL/[] = лише файл). Налаштовується в Налаштування → Документи.
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS worker_fields jsonb;
-- Одноразовий сід дефолтів ЛИШЕ в порожні (NULL) рядки: типи зі строком дії — «дійсний до»,
-- паспорт — ще й номер, badania — дата badań, довідка студента — заклад і період.
-- Свідомо спорожнений офісом список ('[]') повторний прогін не чіпає.
UPDATE document_types SET worker_fields = '["number","expiresAt"]'::jsonb WHERE worker_fields IS NULL AND code = 'passport';
UPDATE document_types SET worker_fields = '["issuedAt","expiresAt"]'::jsonb WHERE worker_fields IS NULL AND code = 'medical_exam';
UPDATE document_types SET worker_fields = '["issuer","validFrom","expiresAt"]'::jsonb WHERE worker_fields IS NULL AND code = 'student_cert';
UPDATE document_types SET worker_fields = '["expiresAt"]'::jsonb WHERE worker_fields IS NULL AND has_expiry = true;
