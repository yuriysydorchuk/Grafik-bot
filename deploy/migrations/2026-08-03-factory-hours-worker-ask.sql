-- Підтвердження годин фабрики самим працівником: розсилка з /hours шле в бот
-- «твої години за місяць — все вірно?» з кнопками; відповідь (✅/❌ + пояснення)
-- показується новою колонкою біля годин фабрики.
ALTER TABLE factory_hours ADD COLUMN IF NOT EXISTS ask_sent_at timestamp;
ALTER TABLE factory_hours ADD COLUMN IF NOT EXISTS ask_hours real;
ALTER TABLE factory_hours ADD COLUMN IF NOT EXISTS worker_response text;
ALTER TABLE factory_hours ADD COLUMN IF NOT EXISTS worker_response_at timestamp;
ALTER TABLE factory_hours ADD COLUMN IF NOT EXISTS worker_note text;
