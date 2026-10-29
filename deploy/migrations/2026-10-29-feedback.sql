-- Зголошення проблем і побажань з веб-панелі (29.10.2026, docs/tasks/2026-10-29-feedback-module.md).
-- Ідемпотентно. Незалежно від 2026-10-29-contract-termination.sql.
CREATE TABLE IF NOT EXISTS feedback_reports (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  severity text,
  status text NOT NULL DEFAULT 'new',
  title text NOT NULL,
  description text NOT NULL,
  steps text,
  expected text,
  about_page boolean NOT NULL DEFAULT true,
  page_path text,
  page_label text,
  page_url text,
  page_filters jsonb,
  origin text NOT NULL DEFAULT 'widget',
  client_error jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  breadcrumbs jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded boolean NOT NULL DEFAULT false,
  build_version text,
  author_admin_id integer NOT NULL REFERENCES admins(id),
  author_seen_at timestamp,
  last_admin_activity_at timestamp,
  reply text,
  duplicate_of_id integer REFERENCES feedback_reports(id) ON DELETE SET NULL,
  task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
  triage jsonb,
  deployed_commit text,
  status_by_admin_id integer,
  status_changed_at timestamp,
  confirm_requested_at timestamp,
  confirm_reminded_at timestamp,
  confirmed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_reports_status_idx ON feedback_reports (status);
CREATE INDEX IF NOT EXISTS feedback_reports_author_idx ON feedback_reports (author_admin_id);
CREATE INDEX IF NOT EXISTS feedback_reports_page_idx ON feedback_reports (page_path);

CREATE TABLE IF NOT EXISTS feedback_attachments (
  id serial PRIMARY KEY,
  report_id integer NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  kind text NOT NULL,
  path text NOT NULL,
  name text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL,
  meta jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback_comments (
  id serial PRIMARY KEY,
  report_id integer NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  admin_id integer REFERENCES admins(id),
  kind text NOT NULL DEFAULT 'comment',
  body text NOT NULL,
  via text NOT NULL DEFAULT 'web',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback_votes (
  report_id integer NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  admin_id integer NOT NULL REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_votes_pk ON feedback_votes (report_id, admin_id);

-- Тип бот-сповіщення «feedback» — типово лише власнику.
UPDATE roles SET notify = notify || '["feedback"]'::jsonb WHERE key = 'owner' AND NOT (notify ? 'feedback');

-- Налаштування модуля (не затирати вже змінені значення).
INSERT INTO settings (key, value) VALUES
  ('feedback.instant_kinds', '["blocks"]'),
  ('feedback.remind_days', '3'),
  ('feedback.confirm_days', '7'),
  ('feedback.widget_off_roles', '[]'),
  ('feedback.dedup_hint', '1')
ON CONFLICT (key) DO NOTHING;
