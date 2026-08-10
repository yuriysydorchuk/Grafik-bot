-- P&L по містах (Етап 2): мапінг обслуговуючого персоналу на міста (з % поділом),
-- прапорець «фабрика з доїздом» для рознесення палива, cost-center місто фактур.

CREATE TABLE IF NOT EXISTS staff_allocations (
  id serial PRIMARY KEY,
  person_key text NOT NULL UNIQUE,               -- нормалізоване імʼя (cleanName) з OFFICE-вкладки
  person_name text,
  allocations jsonb NOT NULL DEFAULT '[]',       -- [{city, pct}], сума pct = 100; порожньо = місто сводної 100%
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE factories ADD COLUMN IF NOT EXISTS fuel_commute boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS city text;
