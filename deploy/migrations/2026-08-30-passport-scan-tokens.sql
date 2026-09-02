-- Публічна веб-сторінка сканування паспорта (/passport-scan/:token) — заміна
-- завантаження фото в Telegram, камера прямо в браузері (worker-docs-signing).
CREATE TABLE IF NOT EXISTS passport_scan_tokens (
  id serial PRIMARY KEY,
  token text NOT NULL UNIQUE,
  purpose text NOT NULL,
  factory_id integer REFERENCES factories(id),
  telegram_id text,
  language text,
  created_by integer REFERENCES admins(id),
  expires_at timestamp NOT NULL,
  used_at timestamp,
  temp_file_path text,
  temp_file_name text,
  temp_file_mime text,
  draft_json jsonb,
  worker_id integer REFERENCES workers(id),
  created_at timestamp NOT NULL DEFAULT now()
);
