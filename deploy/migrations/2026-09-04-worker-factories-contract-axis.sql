-- Вісь «умова» в легальності + кілька фабрик працівника + офісна посада
-- (рішення власника 04.09.2026: оформлений = перебування + праця + чинна умова
-- на КОЖНУ фабрику працівника; для офісної посади — пакет без фабрики).
ALTER TABLE positions ADD COLUMN IF NOT EXISTS is_office boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS worker_factories (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  factory_id integer NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  valid_from date,
  valid_to date,
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_factories_worker_factory_uniq ON worker_factories (worker_id, factory_id);

ALTER TABLE worker_legality ADD COLUMN IF NOT EXISTS contract text NOT NULL DEFAULT 'unknown';
