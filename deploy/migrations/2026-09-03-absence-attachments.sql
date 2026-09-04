-- Підтвердження пропусків (довідки/скріншоти), прикріплені працівником у боті
-- разом із поясненням відсутності. Файли — UPLOADS_DIR/absence-attachments/.
CREATE TABLE IF NOT EXISTS absence_attachments (
  id serial PRIMARY KEY,
  entry_id integer NOT NULL REFERENCES schedule_entries(id) ON DELETE CASCADE,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  file_path text NOT NULL,
  file_name text,
  file_mime text,
  tg_file_id text,
  tg_kind text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS absence_attachments_entry_idx ON absence_attachments(entry_id);
-- Дата/час, коли працівник вніс пояснення пропуску в боті
ALTER TABLE schedule_entries ADD COLUMN IF NOT EXISTS absence_explained_at timestamp;
