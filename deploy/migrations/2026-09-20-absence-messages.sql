-- Листування щодо пропусків (20.09.2026): офіс ↔ працівник у відповідь на пояснення
-- («Написати» на /absences, масове «Нагадати про невиправдані»). Повідомлення офісу
-- відкриває працівнику вікно повторного пояснення і додавання файлу. Ідемпотентно.
CREATE TABLE IF NOT EXISTS absence_messages (
  id serial PRIMARY KEY,
  entry_id integer NOT NULL REFERENCES schedule_entries(id) ON DELETE CASCADE,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  direction text NOT NULL,
  kind text NOT NULL DEFAULT 'message',
  text text NOT NULL,
  admin_id integer REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS absence_messages_entry_idx ON absence_messages (entry_id);
CREATE INDEX IF NOT EXISTS absence_messages_worker_idx ON absence_messages (worker_id);
