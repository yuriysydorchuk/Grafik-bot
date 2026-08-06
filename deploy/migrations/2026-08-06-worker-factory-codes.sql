-- Ключі фабрик: особистий номер працівника в системі фабрики (Nr Osobowy).
-- Імпорт годин матчить рядки спершу по цьому ключу, потім fuzzy по імені.
CREATE TABLE IF NOT EXISTS worker_factory_codes (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  factory_id integer NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  code text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_factory_codes_worker_factory_uniq ON worker_factory_codes (worker_id, factory_id);
CREATE UNIQUE INDEX IF NOT EXISTS worker_factory_codes_factory_code_uniq ON worker_factory_codes (factory_id, code);

-- Бекфіл публічних номерів (worker_code) профілям, створеним разовим скриптом
-- 20.07.2026 без номера — продовжуємо наявну числову послідовність.
WITH mx AS (
  SELECT coalesce(max(worker_code::int), 0) AS m FROM workers WHERE worker_code ~ '^[0-9]+$'
), numbered AS (
  SELECT id, row_number() OVER (ORDER BY id) AS rn FROM workers WHERE worker_code IS NULL
)
UPDATE workers w
SET worker_code = lpad((mx.m + numbered.rn)::text, 5, '0')
FROM mx, numbered
WHERE w.id = numbered.id;
