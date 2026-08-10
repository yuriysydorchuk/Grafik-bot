-- Хостели 2.0: кімнати, платежі мешканців, кауції, місячна ціль; історія
-- занятості з таблиць головного водія (мешканці без профілю в базі — сирим імʼям).

-- Кімнати хостела (з таблиць: «Номер 1 (2 места) семейный тип», ціна кімнати).
CREATE TABLE IF NOT EXISTS hostel_rooms (
  id serial PRIMARY KEY,
  hostel_id integer NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  label text NOT NULL,                 -- «Номер 1», «Чердак», «2 этаж Номер 3»
  capacity integer,                    -- місць
  room_type text,                      -- family | regular
  base_price real,                     -- ціна кімнати zł/міс (з колонки «Цена»)
  sort integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hostel_rooms_hostel_idx ON hostel_rooms (hostel_id);

-- Проживання: кімната, платник, кауції; історичні мешканці можуть не мати
-- профілю працівника → worker_id стає nullable, сире імʼя в resident_name.
ALTER TABLE hostel_stays ALTER COLUMN worker_id DROP NOT NULL;
ALTER TABLE hostel_stays ADD COLUMN IF NOT EXISTS resident_name text;
ALTER TABLE hostel_stays ADD COLUMN IF NOT EXISTS room_id integer REFERENCES hostel_rooms(id);
ALTER TABLE hostel_stays ADD COLUMN IF NOT EXISTS payer text;        -- self (готівка) | payroll (зняття з ЗП)
ALTER TABLE hostel_stays ADD COLUMN IF NOT EXISTS deposit real;      -- кауція при заселенні (200 зл)
ALTER TABLE hostel_stays ADD COLUMN IF NOT EXISTS key_deposit real;  -- застава за ключ (50 зл)
ALTER TABLE hostel_stays ADD COLUMN IF NOT EXISTS source_ref text;   -- провенанс міграції (файл|аркуш|рядок)

-- Платежі мешканців по місяцях (готівка/картка «платит сам» + зняття payroll —
-- історія з таблиць; далі готівку веде водій через касу/сторінку хостелів).
CREATE TABLE IF NOT EXISTS hostel_payments (
  id serial PRIMARY KEY,
  hostel_id integer NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  stay_id integer REFERENCES hostel_stays(id) ON DELETE SET NULL,
  worker_id integer REFERENCES workers(id),
  resident_name text,                  -- сире імʼя, коли не заматчилось
  period_month text NOT NULL,          -- YYYY-MM
  amount real NOT NULL,
  method text NOT NULL DEFAULT 'cash', -- cash | card | payroll
  note text,
  source_ref text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hostel_payments_month_idx ON hostel_payments (period_month);
CREATE INDEX IF NOT EXISTS hostel_payments_hostel_idx ON hostel_payments (hostel_id);

-- Місячна ціль доходу хостела («Цель: 20000»).
ALTER TABLE hostels ADD COLUMN IF NOT EXISTS monthly_target real;

-- Cap hostelOps: операційне ведення хостелів (кімнати/проживання/платежі) без
-- фінансового шару. Головний водій (роль driver) веде хостели сам.
UPDATE roles SET caps = caps || '["hostelOps"]'::jsonb
  WHERE key = 'driver' AND NOT caps ? 'hostelOps';
UPDATE roles SET pages = pages || '["/hostels"]'::jsonb
  WHERE key = 'driver' AND NOT pages ? '/hostels';
