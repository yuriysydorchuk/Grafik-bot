-- Транспорт/залічки/бадання/магазин одягу (12.08.2026)
-- 0) канонізація unique-індексів monthly_reports: рапорт — на пару worker+month+factory
--    (мідмісячний трансфер = окремий рапорт на фабрику). Дев/прод правились руками,
--    schema.sql відстав — тестова БД і CI будуються звідси, тож фіксуємо міграцією.
DROP INDEX IF EXISTS monthly_reports_worker_month_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS monthly_reports_worker_month_factory_uniq
  ON monthly_reports (worker_id, month, factory_id);
CREATE UNIQUE INDEX IF NOT EXISTS monthly_reports_worker_month_nofactory_uniq
  ON monthly_reports (worker_id, month) WHERE factory_id IS NULL;
-- 1) self_transport з датою «діє з» (генерація знять за довіз рахує помісячно)
ALTER TABLE workers ADD COLUMN IF NOT EXISTS self_transport_since date;
-- 2) залічка за бадання в профілі: сума + позначка «знято з ЗП»
ALTER TABLE workers ADD COLUMN IF NOT EXISTS badania_zaliczka real;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS badania_deducted boolean NOT NULL DEFAULT false;
-- 3) залічка привʼязується до фабрики, з якої її просили (from-hours кладе в її рядок)
ALTER TABLE advance_requests ADD COLUMN IF NOT EXISTS factory_id integer REFERENCES factories(id);
-- 4) хто позначив аванс «виплачено» (вручну; авто-помітка лишає NULL + paid_txn_id)
ALTER TABLE advance_requests ADD COLUMN IF NOT EXISTS paid_by integer REFERENCES admins(id);
-- 5) магазин одягу: склад (тип/розмір/стан/ціна/кількість)
CREATE TABLE IF NOT EXISTS clothing_stock (
  id serial PRIMARY KEY,
  item_type text NOT NULL,                    -- boots | coverall | jacket | hat | tshirt | set | other
  name text,                                  -- уточнення назви (опційно)
  size text,
  condition text NOT NULL DEFAULT 'new',      -- new | used
  price real,                                 -- ціна зняття з ЗП при видачі
  qty integer NOT NULL DEFAULT 0,
  note text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);
-- 6) видача одягу: звʼязок зі складом, розмір/стан, дати видачі/повернення,
--    фактичне зняття (скільки і з якої сводної)
ALTER TABLE clothing_items ADD COLUMN IF NOT EXISTS stock_id integer REFERENCES clothing_stock(id);
ALTER TABLE clothing_items ADD COLUMN IF NOT EXISTS size text;
ALTER TABLE clothing_items ADD COLUMN IF NOT EXISTS condition text;
ALTER TABLE clothing_items ADD COLUMN IF NOT EXISTS issued_at date;
ALTER TABLE clothing_items ADD COLUMN IF NOT EXISTS returned_at date;
ALTER TABLE clothing_items ADD COLUMN IF NOT EXISTS deducted_amount real;
ALTER TABLE clothing_items ADD COLUMN IF NOT EXISTS deducted_month text;
