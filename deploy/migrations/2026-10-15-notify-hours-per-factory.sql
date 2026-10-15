-- Години в powiadomieniu по фабриці (15.10.2026, рішення власника):
--  * factories.ua_notify_hours — години в повідомленні (3.6) для людей фабрики, єдине джерело форми;
--  * worker_notify_hours — години людини на фабриці (ліміт konto рядка сводної цієї фабрики):
--    manual (вручну) або powiadomienie (з документа). Немає рядка → workers.notify_hours (старе спільне, ручне);
--  * worker_changes.factory_id — фабрика, якої стосується зміна в журналі профілю.
-- Ідемпотентна; з даних — лише стандарт 40 год/міс у фабриках без годин.
ALTER TABLE factories ADD COLUMN IF NOT EXISTS ua_notify_hours integer;
-- стандарт 40 год/міс для всіх фабрик (рішення власника 15.10.2026) — і для нових фабрик теж;
-- сід лише в порожні (файл накатується на проді один раз; повтор не затре змінене вручну)
ALTER TABLE factories ALTER COLUMN ua_notify_hours SET DEFAULT 40;
UPDATE factories SET ua_notify_hours = 40 WHERE ua_notify_hours IS NULL;

CREATE TABLE IF NOT EXISTS worker_notify_hours (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  factory_id integer NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  hours real NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  document_id integer REFERENCES worker_documents(id) ON DELETE SET NULL,
  updated_by integer REFERENCES admins(id),
  updated_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_notify_hours_worker_factory_uniq ON worker_notify_hours (worker_id, factory_id);

-- без FK свідомо: після видалення фабрики запис лишається «по фабриці» (NULL означав би спільну зміну)
ALTER TABLE worker_changes ADD COLUMN IF NOT EXISTS factory_id integer;
