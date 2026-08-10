-- Облік спецодягу: видача працівникам (наш/свій/на продаж), ціна зняття з ЗП.
-- Джерело процесу — таблиці водія «Учёт рабочей одежды» / «Forma» (мігровано 07.2026).
CREATE TABLE IF NOT EXISTS clothing_items (
  id serial PRIMARY KEY,
  worker_id integer REFERENCES workers(id),
  worker_name text,               -- сире імʼя, коли не заматчилось (історія)
  item_type text NOT NULL,        -- boots | coverall | jacket | hat | tshirt | set | other
  ownership text,                 -- ours (наш, видано) | own (своє) | sold (продано — зняти з ЗП)
  price real,                     -- ціна зняття з ЗП (20/25/50/130…)
  deducted boolean NOT NULL DEFAULT false, -- «вже знято»
  period_month text,              -- YYYY-MM, де відомий
  note text,
  source_ref text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clothing_items_worker_idx ON clothing_items (worker_id);

-- Сторінка «Одяг» (/clothing) — ролям driver і scheduler.
UPDATE roles SET pages = pages || '["/clothing"]'::jsonb
  WHERE key IN ('driver', 'scheduler') AND NOT pages ? '/clothing';

-- Списання: історичні «не зняті з ЗП» позиції можна списати (рішення власника
-- 01.08.2026 — мігрований хвіст 2022–2024 списано; списане не входить у підсумок «до зняття»).
ALTER TABLE clothing_items ADD COLUMN IF NOT EXISTS written_off boolean NOT NULL DEFAULT false;
