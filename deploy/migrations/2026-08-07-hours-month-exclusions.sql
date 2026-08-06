-- Виключення працівника з місяця Обліку годин (прибрати зі списку / відпустка /
-- ще не приступив). Ховає лише авто-доданий нульовий рядок місяця.
CREATE TABLE IF NOT EXISTS hours_month_exclusions (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  month text NOT NULL,
  reason text NOT NULL DEFAULT 'manual',
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hours_month_exclusions_uniq ON hours_month_exclusions (worker_id, month);
