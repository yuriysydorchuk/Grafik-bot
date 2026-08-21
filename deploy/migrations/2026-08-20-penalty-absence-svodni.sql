-- Перенесення штрафів (/penalties) і штрафів за пропуски (/absences) у колонку
-- Kara сводної — статус «знято» на джерелах (дзеркало worker_badania.deducted).
ALTER TABLE penalties ADD COLUMN IF NOT EXISTS deducted boolean NOT NULL DEFAULT false;
ALTER TABLE penalties ADD COLUMN IF NOT EXISTS deducted_at date;
ALTER TABLE penalties ADD COLUMN IF NOT EXISTS deducted_month text;

-- Штраф пропуску живе на schedule_entries; сума фіксується на момент переносу
-- (штраф міг би редагуватись пізніше — undo віднімає саме зафіксоване).
ALTER TABLE schedule_entries ADD COLUMN IF NOT EXISTS absence_deducted_month text;
ALTER TABLE schedule_entries ADD COLUMN IF NOT EXISTS absence_deducted_at date;
ALTER TABLE schedule_entries ADD COLUMN IF NOT EXISTS absence_deducted_amount real;
