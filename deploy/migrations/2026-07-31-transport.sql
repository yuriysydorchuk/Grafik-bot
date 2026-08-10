-- Транспортні гроші: архів логістичних таблиць водія (2022–2026), ставки
-- оплати водіям за виїзд (водій × фабрика) і зняття з ЗП працівників за довіз.

-- Архів «Контроль поездок по фабрикам»: один рядок = один виїзд (зміна × дата).
-- Операційні driver_workdays НЕ чіпаємо — архів живе окремо, звʼязки через *_id.
CREATE TABLE IF NOT EXISTS driver_trip_log (
  id serial PRIMARY KEY,
  trip_date date NOT NULL,
  factory_label text NOT NULL,          -- підпис фабрики з таблиці (LST, AGRAM MOTYCZ, ALMIZ, Office…)
  factory_id integer REFERENCES factories(id),  -- матч до наших фабрик (де вдалося)
  shift_time text,                      -- час зміни з таблиці ("7:00", "15:00", "23:00")
  driver_name text,                     -- сирий підпис водія
  driver_id integer REFERENCES drivers(id),
  vehicle_plate text,                   -- сирий номер авто
  vehicle_id integer REFERENCES vehicles(id),
  odo_from integer,
  odo_to integer,
  km integer,
  people integer,                       -- скільки людей везли
  pay_amount real,                      -- оплата водієві за цей виїзд (колонки імен у таблиці)
  note text,                            -- ПРОЧЕЕ (ДОВОЗ, PF тощо)
  source_ref text NOT NULL,             -- файл|аркуш|рядок
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_trip_log_date_idx ON driver_trip_log (trip_date);
CREATE INDEX IF NOT EXISTS driver_trip_log_factory_idx ON driver_trip_log (factory_label);
CREATE INDEX IF NOT EXISTS driver_trip_log_driver_idx ON driver_trip_log (driver_id);

-- Ставки оплати водіям за виїзд: базова в профілі водія + оверрайд по фабриці.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS trip_rate real;  -- зл/виїзд, NULL = не платиться
CREATE TABLE IF NOT EXISTS driver_trip_rates (
  id serial PRIMARY KEY,
  driver_id integer NOT NULL REFERENCES drivers(id),
  factory_id integer NOT NULL REFERENCES factories(id),
  rate real NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (driver_id, factory_id)
);

-- Зняття з ЗП працівників за довіз (дзеркало hostel_deductions):
-- місяць × працівник × фабрика. Міграція «Контроль поездок работника» + ручний CRUD.
CREATE TABLE IF NOT EXISTS transport_deductions (
  id serial PRIMARY KEY,
  period_month text NOT NULL,           -- YYYY-MM
  worker_id integer REFERENCES workers(id),
  worker_name text,                     -- сирий підпис, коли не заматчилось
  factory_id integer REFERENCES factories(id),
  factory_label text,
  trips_count integer,                  -- кількість виїздів за місяць
  amount real NOT NULL DEFAULT 0,       -- сума зняття
  note text,
  source_ref text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transport_deductions_month_idx ON transport_deductions (period_month);
CREATE INDEX IF NOT EXISTS transport_deductions_worker_idx ON transport_deductions (worker_id);

-- Сторінка «Транспорт» (/transport) — ролям driver і scheduler.
UPDATE roles SET pages = pages || '["/transport"]'::jsonb
  WHERE key IN ('driver', 'scheduler') AND NOT pages ? '/transport';
