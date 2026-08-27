-- Прибирання: довідник працівників (вкладка «Працівники» на /cleaning) з позиціями
-- оплат по вспульнотах (фіксована сума за позицію АБО % від ЗП) + вага поділу ЗП
-- у привʼязках місячних винагороджень (share; NULL у всіх = порівну, як раніше).
CREATE TABLE IF NOT EXISTS cleaning_workers (
  id serial PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cleaning_worker_rates (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES cleaning_workers(id) ON DELETE CASCADE,
  project_ids jsonb NOT NULL DEFAULT '[]',
  amount real,
  pct real,
  note text
);

ALTER TABLE cleaning_payroll_projects ADD COLUMN IF NOT EXISTS share real;
