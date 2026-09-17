-- Журнал очищень вкладки сводної: снапшот рядків «Очистити вкладку» + відновлення.
CREATE TABLE IF NOT EXISTS svodni_clears (
  id serial PRIMARY KEY,
  period_month text NOT NULL,
  city text NOT NULL,
  factory_label text NOT NULL,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT 'clear',
  sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  cleared_by integer REFERENCES admins(id),
  cleared_at timestamp NOT NULL DEFAULT now(),
  restored_at timestamp,
  restored_by integer REFERENCES admins(id)
);
CREATE INDEX IF NOT EXISTS svodni_clears_scope_idx ON svodni_clears (period_month, city, factory_label);
