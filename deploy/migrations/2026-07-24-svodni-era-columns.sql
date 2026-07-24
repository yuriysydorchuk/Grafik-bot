-- Колонки/таблиці, які історично зʼявились у міграції сводної 2.0 (видалена
-- разом з фічею), але використовуються ПЕРШОЮ сводною і штрафами — на прод
-- вони так і не потрапили. Ідемпотентно.

-- Фабрики: місто (сводні групують по містах) + базова пара ставок і нічна доплата
ALTER TABLE factories ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS rate_brutto real;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS rate_netto real;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS night_addon real;

-- Пара нетто у ставках посад фабрики
ALTER TABLE factory_positions ADD COLUMN IF NOT EXISTS rate_netto real;

-- Бонусні галочки (Agram нал+стаж, LST нал)
ALTER TABLE workers ADD COLUMN IF NOT EXISTS agram_staz_bonus boolean NOT NULL DEFAULT false;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS agram_cash_bonus boolean NOT NULL DEFAULT false;

-- Штрафи (kary) — ручний реєстр по місяцях (роутер /penalties)
CREATE TABLE IF NOT EXISTS penalties (
  id serial PRIMARY KEY,
  period_month text NOT NULL,
  worker_id integer NOT NULL REFERENCES workers(id),
  city text,
  factory_id integer REFERENCES factories(id),
  factory_label text,
  amount real NOT NULL,
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);
