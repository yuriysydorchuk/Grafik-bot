-- Походження анкети працівника: NULL = заповнена в системі, 'hrappka' = разовий імпорт
-- з експорту HRappka (21.09.2026). Ідемпотентно.
ALTER TABLE worker_questionnaires
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS imported_at timestamp;
