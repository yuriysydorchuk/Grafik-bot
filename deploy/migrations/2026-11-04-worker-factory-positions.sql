-- Посада людини ПО ФАБРИЦІ (зголошення #12, рішення власника 03.11.2026). Нема рядка пари →
-- workers.position_id (як раніше), тож до першого заповнення поведінка не змінюється. Ідемпотентна.
CREATE TABLE IF NOT EXISTS worker_factory_positions (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  factory_id integer NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  position_id integer NOT NULL REFERENCES positions(id),
  updated_by integer REFERENCES admins(id),
  updated_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_factory_positions_worker_factory_uniq ON worker_factory_positions (worker_id, factory_id);
