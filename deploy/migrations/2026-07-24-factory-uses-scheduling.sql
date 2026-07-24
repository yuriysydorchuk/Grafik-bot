-- Прапорець «планування графіків»: false = фабрика лише зарплатна —
-- не світиться у замовленнях/графіках/доступності, генерація її пропускає,
-- cron не просить доступність у її працівників. Лодзь/Познань вимикаються одразу.
ALTER TABLE factories ADD COLUMN IF NOT EXISTS uses_scheduling boolean NOT NULL DEFAULT true;
UPDATE factories SET uses_scheduling = false WHERE city IN ('Лодзь', 'Познань');
-- EUROCASH (усі три) — теж без графіків, лише зарплатні
UPDATE factories SET uses_scheduling = false WHERE name ILIKE 'EUROCASH%';
