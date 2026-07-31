-- Разові зміни на конкретний день фабрики (день+№ зміни+час).
-- Дозволяють призначити зміну поза стандартним shift_count фабрики так, щоб
-- пуші/водійський борд/Excel знали її час.
CREATE TABLE IF NOT EXISTS factory_shift_overrides (
  id serial PRIMARY KEY,
  factory_id integer NOT NULL REFERENCES factories(id),
  date date NOT NULL,
  shift shift NOT NULL,
  "start" text NOT NULL,
  "end" text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS factory_shift_overrides_uniq
  ON factory_shift_overrides (factory_id, date, shift);
