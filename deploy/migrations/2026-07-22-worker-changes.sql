-- Журнал змін профілю працівника з датою набуття: історія станів людини
-- (легалізація, ставки, посада, бонуси Agram, дати, звільнення/поновлення).
-- Фундамент пропагації змін у сводні заднім числом і сегментів усередині місяця.
CREATE TABLE IF NOT EXISTS worker_changes (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  field text NOT NULL,
  old_value text,
  new_value text,
  effective_date date NOT NULL,
  applied_rows jsonb,
  skipped_locked jsonb,
  admin_id integer REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_changes_worker_idx ON worker_changes(worker_id, effective_date);
