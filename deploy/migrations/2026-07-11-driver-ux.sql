-- Driver UX pack: fleet vehicles, workday vehicle, substitutions, shift cancellations.
-- Apply: psql "$DATABASE_URL" -f deploy/migrations/2026-07-11-driver-ux.sql

CREATE TABLE IF NOT EXISTS vehicles (
  id serial PRIMARY KEY,
  plate text NOT NULL,
  brand_model text,
  seats integer,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE driver_workdays
  ADD COLUMN IF NOT EXISTS vehicle_id integer REFERENCES vehicles(id);

ALTER TABLE unplanned_workers
  ADD COLUMN IF NOT EXISTS replaces_worker_id integer REFERENCES workers(id);

CREATE TABLE IF NOT EXISTS shift_cancellations (
  id serial PRIMARY KEY,
  week_id integer NOT NULL REFERENCES schedule_weeks(id),
  factory_id integer NOT NULL REFERENCES factories(id),
  day_of_week day_of_week NOT NULL,
  shift shift NOT NULL,
  cancelled_by text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shift_cancellations_cell_uniq
  ON shift_cancellations (week_id, factory_id, day_of_week, shift);
