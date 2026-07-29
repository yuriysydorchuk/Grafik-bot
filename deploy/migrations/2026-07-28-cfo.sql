-- CFO-модуль: збережені АІ-висновки місячного аналізу.
CREATE TABLE IF NOT EXISTS cfo_reports (
  id serial PRIMARY KEY,
  period_month text NOT NULL,
  content text NOT NULL,
  model text,
  auto boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now()
);
