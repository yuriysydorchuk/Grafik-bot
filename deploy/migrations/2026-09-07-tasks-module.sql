-- Модуль «Задачі» (06.09.2026): задачі офісу, групові задачі та зустрічі, автозадачі
-- з движка легалізації, відповідальний/графікова фабрики.
ALTER TABLE factories ADD COLUMN IF NOT EXISTS responsible_admin_id integer REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS scheduler_admin_id integer REFERENCES admins(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id serial PRIMARY KEY,
  kind text NOT NULL DEFAULT 'task',
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'normal',
  due_at date,
  due_time text,
  duration_min integer,
  place text,
  planned_for date,
  planned_time text,
  snoozed_until date,
  rollover_count integer NOT NULL DEFAULT 0,
  creator_admin_id integer REFERENCES admins(id),
  assignee_admin_id integer REFERENCES admins(id),
  review_required boolean NOT NULL DEFAULT false,
  worker_id integer REFERENCES workers(id) ON DELETE SET NULL,
  factory_id integer REFERENCES factories(id) ON DELETE SET NULL,
  document_id integer REFERENCES worker_documents(id) ON DELETE SET NULL,
  contract_id integer REFERENCES contracts(id) ON DELETE SET NULL,
  candidate_id integer REFERENCES candidates(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual',
  source_key text,
  auto_params jsonb,
  checklist jsonb NOT NULL DEFAULT '[]',
  recurrence jsonb,
  recurrence_parent_id integer,
  reminders_sent jsonb NOT NULL DEFAULT '[]',
  template_id integer,
  completed_at timestamp,
  completed_by_id integer REFERENCES admins(id),
  resolution_note text,
  escalated_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_source_key_uq ON tasks (source_key);
CREATE INDEX IF NOT EXISTS tasks_assignee_status_idx ON tasks (assignee_admin_id, status);
CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks (due_at);
CREATE INDEX IF NOT EXISTS tasks_worker_idx ON tasks (worker_id);

CREATE TABLE IF NOT EXISTS task_assignees (
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  admin_id integer NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  responded_at timestamp,
  note text
);
CREATE UNIQUE INDEX IF NOT EXISTS task_assignees_uq ON task_assignees (task_id, admin_id);

CREATE TABLE IF NOT EXISTS task_comments (
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  admin_id integer REFERENCES admins(id),
  body text NOT NULL,
  mentions jsonb NOT NULL DEFAULT '[]',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_events (
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  admin_id integer REFERENCES admins(id),
  kind text NOT NULL,
  payload jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id);

CREATE TABLE IF NOT EXISTS task_templates (
  id serial PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'task',
  title_template text NOT NULL,
  description text,
  checklist jsonb NOT NULL DEFAULT '[]',
  default_assignee_admin_id integer REFERENCES admins(id),
  review_required boolean NOT NULL DEFAULT false,
  due_in_days integer,
  recurrence jsonb,
  trigger text NOT NULL DEFAULT 'manual',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_auto_rules (
  code text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  lead_days integer,
  fallback_admin_id integer REFERENCES admins(id),
  params jsonb NOT NULL DEFAULT '{}',
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Сторінка /tasks уже в каталозі; ролям з доступом до працівників — і задачі,
-- і тип бот-сповіщень «tasks» (інакше призначення/нагадування нікому не дійдуть)
UPDATE roles SET pages = pages || '["/tasks"]'::jsonb WHERE NOT (pages ? '/tasks') AND (pages ? '/workers');
UPDATE roles SET notify = notify || '["tasks"]'::jsonb WHERE NOT (notify ? 'tasks') AND (pages ? '/tasks');
