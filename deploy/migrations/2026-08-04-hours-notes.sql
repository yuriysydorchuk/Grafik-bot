-- Замітки Обліку годин: вільний текст до пари (працівник, місяць, фабрика).
-- Робоча нотатка графіка/офісу, не фінансове поле.
CREATE TABLE IF NOT EXISTS hours_notes (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id),
  month text NOT NULL,
  factory_id integer REFERENCES factories(id),
  note text NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hours_notes_worker_month_factory_uniq
  ON hours_notes (worker_id, month, factory_id);
-- Legacy-рядки без фабрики: максимум одна замітка на працівника+місяць.
CREATE UNIQUE INDEX IF NOT EXISTS hours_notes_worker_month_nofactory_uniq
  ON hours_notes (worker_id, month) WHERE factory_id IS NULL;
