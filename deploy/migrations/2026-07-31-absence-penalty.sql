-- Відсутності: «виправдання» пропуску (не рахується в кількість/штраф) і
-- штраф за пропуск (NULL = стандартні 300 zł, override у zł, 0 = анульовано).
ALTER TABLE schedule_entries ADD COLUMN IF NOT EXISTS absence_excused boolean NOT NULL DEFAULT false;
ALTER TABLE schedule_entries ADD COLUMN IF NOT EXISTS absence_penalty real;
