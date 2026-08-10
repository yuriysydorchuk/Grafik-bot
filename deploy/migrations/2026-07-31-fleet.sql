-- Автопарк 2.0: розширення vehicles (дані з таблиці головного водія «АВТОПАРК 2»)
-- + облік витрат на авто (ремонти) і реєстр фактур сервісів.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS company_id integer REFERENCES companies(id);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS owner_name text;            -- у кого орендуємо (приватна особа), NULL = власне/лізинг фірми
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel text;                  -- B | D | B/G
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS year integer;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vin text;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS ownership text;             -- umowa | leasing | faktura | private
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS insurance_until date;       -- UBEZP (OC/AC)
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS inspection_until date;      -- TO (przegląd techniczny)
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rent_monthly real; -- оренда/міс (фінансове, owner-only)
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS purchase_price real;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS market_price real;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS purchased_at date;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS sold_at date;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'; -- active | sold | scrapped
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS kind text;                  -- car | bus (легкове/автобус — секції таблиці водія)
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS equipment jsonb NOT NULL DEFAULT '{}'::jsonb; -- інвентар: домкрат/насос/вогнегасник/аптечка/жилетка…
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS notes text;

-- Витрати на авто (ремонти/шини/інше) по місяцях. source_ref = провенанс міграції (файл|аркуш|рядок).
CREATE TABLE IF NOT EXISTS vehicle_expenses (
  id serial PRIMARY KEY,
  vehicle_id integer REFERENCES vehicles(id),
  vehicle_label text,                 -- сирий підпис авто з таблиці, коли не заматчилось (напр. «audi i bmw И ПАНДА»)
  month text NOT NULL,                -- YYYY-MM
  amount real NOT NULL,
  kind text NOT NULL DEFAULT 'repair', -- repair | tire | other
  service text,                       -- сервіс (Techno House, AUTOTRONIK…)
  invoice_no text,
  note text,                          -- напр. «замена двигателя»
  source_ref text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_expenses_month_idx ON vehicle_expenses (month);
CREATE INDEX IF NOT EXISTS vehicle_expenses_vehicle_idx ON vehicle_expenses (vehicle_id);

-- Сторінка «Автопарк» (/fleet) — системним ролям driver і scheduler (owner має все в коді).
-- Ідемпотентно: додаємо лише якщо ще нема.
UPDATE roles SET pages = pages || '["/fleet"]'::jsonb
  WHERE key IN ('driver', 'scheduler') AND NOT pages ? '/fleet';

-- Реєстр фактур автосервісів (шапки FV… з аркушів «Ремонт NNNN»). Довідковий шар:
-- аналітика витрат іде по vehicle_expenses, фактури — для звірки з банком/фактурами витрат.
CREATE TABLE IF NOT EXISTS vehicle_service_invoices (
  id serial PRIMARY KEY,
  invoice_no text NOT NULL,
  service text,
  month text NOT NULL,                -- YYYY-MM
  amount real NOT NULL,
  source_ref text,
  created_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (invoice_no, month, amount)
);
