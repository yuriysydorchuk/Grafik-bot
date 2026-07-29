-- Години з фабрики (звірка з рапортами працівників) — сторінка «Облік годин».
CREATE TABLE IF NOT EXISTS factory_hours (
  id SERIAL PRIMARY KEY,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  month TEXT NOT NULL,
  factory_id INTEGER NOT NULL REFERENCES factories(id),
  hours REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  days JSONB, -- "YYYY-MM-DD" → год (розбивка з файлів фабрик для позмінної звірки)
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
-- Якщо таблиця вже існувала без days (локальний дев) — доклеїти колонку.
ALTER TABLE factory_hours ADD COLUMN IF NOT EXISTS days JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS factory_hours_worker_month_factory_uniq
  ON factory_hours (worker_id, month, factory_id);
