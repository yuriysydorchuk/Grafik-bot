-- Тижневий облік годин: підтвердження годин фабрики працівником по тижню (дзеркало factory_hours.ask_*/worker_*).
ALTER TABLE factory_week_hours ADD COLUMN IF NOT EXISTS ask_sent_at timestamp;
ALTER TABLE factory_week_hours ADD COLUMN IF NOT EXISTS ask_hours real;
ALTER TABLE factory_week_hours ADD COLUMN IF NOT EXISTS worker_response text;
ALTER TABLE factory_week_hours ADD COLUMN IF NOT EXISTS worker_response_at timestamp;
ALTER TABLE factory_week_hours ADD COLUMN IF NOT EXISTS worker_note text;
