-- «Роботодавці» (рішення власника 05.09.2026): кожна фабрика працівника має свою
-- нашу фірму; умова — від фірми фабрики; підстава праці — на кожного роботодавця.
-- Офіс = фабрика з is_office (посади без фабрики не буває) — positions.is_office прибираємо.
ALTER TABLE worker_factories ADD COLUMN IF NOT EXISTS company_id integer REFERENCES companies(id);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS company_id integer REFERENCES companies(id);
ALTER TABLE factories ADD COLUMN IF NOT EXISTS is_office boolean NOT NULL DEFAULT false;
ALTER TABLE positions DROP COLUMN IF EXISTS is_office;

-- бекфіл фірми в наявних умовах: фірма фабрики, інакше фірма працівника на момент бекфілу
UPDATE contracts c SET company_id = COALESCE(
  (SELECT f.company_id FROM factories f WHERE f.id = c.factory_id),
  (SELECT w.company_id FROM workers w WHERE w.id = c.worker_id)
) WHERE c.company_id IS NULL;
