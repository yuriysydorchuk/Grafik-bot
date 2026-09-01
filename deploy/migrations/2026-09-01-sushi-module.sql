BEGIN;

-- 1. Темпоральні фабричні коди (Nr RCP) для працівників
CREATE TABLE IF NOT EXISTS sushi_worker_codes (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  factory_id integer NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  company_id integer NOT NULL REFERENCES companies(id),
  rcp_code text NOT NULL,
  valid_from date NOT NULL DEFAULT '2020-01-01',
  valid_to date,
  is_primary boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sushi_worker_codes_search_idx ON sushi_worker_codes (factory_id, rcp_code, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS sushi_worker_codes_worker_idx ON sushi_worker_codes (worker_id);

-- 2. Довідник локальних ролей та виробничих ліній
CREATE TABLE IF NOT EXISTS sushi_roles (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  color_badge text DEFAULT '#3b82f6',
  default_client_rate real NOT NULL,
  default_worker_rate real NOT NULL,
  is_billable_to_client boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sushi_lines (
  id serial PRIMARY KEY,
  factory_id integer NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  requires_leader boolean NOT NULL DEFAULT true,
  min_staffing integer DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  UNIQUE (factory_id, code)
);

CREATE TABLE IF NOT EXISTS sushi_line_aliases (
  id serial PRIMARY KEY,
  line_id integer NOT NULL REFERENCES sushi_lines(id) ON DELETE CASCADE,
  raw_alias text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sushi_supervisors (
  id serial PRIMARY KEY,
  signature_name text NOT NULL UNIQUE,
  worker_id integer REFERENCES workers(id),
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS sushi_worker_roles (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  role_id integer NOT NULL REFERENCES sushi_roles(id) ON DELETE CASCADE,
  custom_client_rate real,
  custom_worker_rate real,
  is_primary boolean NOT NULL DEFAULT false,
  UNIQUE (worker_id, role_id)
);

CREATE TABLE IF NOT EXISTS sushi_worker_lines (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  line_id integer NOT NULL REFERENCES sushi_lines(id) ON DELETE CASCADE,
  is_preferred boolean NOT NULL DEFAULT true,
  UNIQUE (worker_id, line_id)
);

-- 3. Пакети імпорту та Staging Area
CREATE TABLE IF NOT EXISTS sushi_import_batches (
  id serial PRIMARY KEY,
  factory_id integer NOT NULL REFERENCES factories(id),
  company_id integer REFERENCES companies(id),
  source_filename text NOT NULL,
  file_hash_sha256 text NOT NULL UNIQUE,
  report_date date NOT NULL,
  shift_type text,
  total_rows_count integer NOT NULL DEFAULT 0,
  valid_rows_count integer NOT NULL DEFAULT 0,
  error_rows_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING',
  uploaded_by_admin_id integer REFERENCES admins(id),
  ingested_via text NOT NULL DEFAULT 'WEB_UPLOAD',
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sushi_import_batches_date_idx ON sushi_import_batches (factory_id, report_date);

CREATE TABLE IF NOT EXISTS sushi_staging_entries (
  id serial PRIMARY KEY,
  batch_id integer NOT NULL REFERENCES sushi_import_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  raw_firma text,
  raw_rcp text,
  raw_dzial text,
  raw_od text,
  raw_do text,
  raw_realne_godziny text,
  raw_podpis text,
  raw_uwagi text,
  resolved_worker_id integer REFERENCES workers(id),
  resolved_line_id integer REFERENCES sushi_lines(id),
  resolved_role_id integer REFERENCES sushi_roles(id),
  resolved_supervisor_id integer REFERENCES sushi_supervisors(id),
  validation_status text NOT NULL DEFAULT 'PENDING',
  error_message text,
  is_processed boolean NOT NULL DEFAULT false,
  processed_interval_id integer,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sushi_staging_batch_status_idx ON sushi_staging_entries (batch_id, validation_status);

-- 4. Головний табель робочих інтервалів
CREATE TABLE IF NOT EXISTS sushi_work_intervals (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  factory_id integer NOT NULL REFERENCES factories(id),
  company_id integer NOT NULL REFERENCES companies(id),
  line_id integer NOT NULL REFERENCES sushi_lines(id),
  role_id integer NOT NULL REFERENCES sushi_roles(id),
  supervisor_id integer REFERENCES sushi_supervisors(id),
  staging_entry_id integer REFERENCES sushi_staging_entries(id) ON DELETE SET NULL,
  shift_group_id text,
  work_date date NOT NULL,
  billing_month text NOT NULL,
  start_at timestamp with time zone,
  stop_at timestamp with time zone,
  start_time text NOT NULL,
  stop_time text NOT NULL,
  rounded_start_time text NOT NULL,
  rounded_stop_time text NOT NULL,
  raw_hours real NOT NULL,
  rounded_hours real NOT NULL,
  billable_hours real NOT NULL,
  payable_hours real NOT NULL,
  applied_client_rate real NOT NULL,
  applied_worker_rate real NOT NULL,
  rate_snapshot_source text NOT NULL DEFAULT 'ROLE_DEFAULT',
  is_primary_daily_interval boolean NOT NULL DEFAULT true,
  odziez_fee_applicable boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'SYNCED',
  confirmed_at timestamp,
  confirmed_by_worker boolean NOT NULL DEFAULT false,
  is_manual_override boolean NOT NULL DEFAULT false,
  override_reason text,
  created_via text NOT NULL DEFAULT 'IMPORT',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sushi_intervals_worker_month_idx ON sushi_work_intervals (worker_id, billing_month);
CREATE INDEX IF NOT EXISTS sushi_intervals_date_company_idx ON sushi_work_intervals (work_date, company_id);
CREATE INDEX IF NOT EXISTS sushi_intervals_factory_month_idx ON sushi_work_intervals (factory_id, billing_month);

-- 5. Диспути та скарги
CREATE TABLE IF NOT EXISTS sushi_disputes (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id),
  work_interval_id integer REFERENCES sushi_work_intervals(id) ON DELETE SET NULL,
  dispute_type text NOT NULL,
  target_date date NOT NULL,
  billing_month text NOT NULL,
  claimed_start_time text,
  claimed_stop_time text,
  claimed_hours real,
  claimed_line_id integer REFERENCES sushi_lines(id),
  worker_comment text,
  evidence_photo_file_id text,
  status text NOT NULL DEFAULT 'OPEN',
  resolution_action text,
  admin_resolution_note text,
  resolved_by_admin_id integer REFERENCES admins(id),
  resolved_at timestamp,
  supervisor_penalty_applied boolean NOT NULL DEFAULT false,
  penalty_id integer REFERENCES penalties(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sushi_disputes_worker_status_idx ON sushi_disputes (worker_id, status);
CREATE INDEX IF NOT EXISTS sushi_disputes_month_idx ON sushi_disputes (billing_month, status);

-- 6. Załącznik та виключення звірки
CREATE TABLE IF NOT EXISTS sushi_zalacznik_summaries (
  id serial PRIMARY KEY,
  factory_id integer NOT NULL REFERENCES factories(id),
  company_id integer NOT NULL REFERENCES companies(id),
  period_month text NOT NULL,
  total_billable_hours real NOT NULL DEFAULT 0,
  total_labor_cost_net real NOT NULL DEFAULT 0,
  total_contractual_penalties real NOT NULL DEFAULT 0,
  total_odziez_days_count integer NOT NULL DEFAULT 0,
  total_odziez_deduction_net real NOT NULL DEFAULT 0,
  other_adjustments_net real NOT NULL DEFAULT 0,
  final_invoice_net real NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_locked boolean NOT NULL DEFAULT false,
  locked_at timestamp,
  locked_by_admin_id integer REFERENCES admins(id),
  generated_pdf_path text,
  generated_xlsx_path text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (factory_id, company_id, period_month)
);

CREATE TABLE IF NOT EXISTS sushi_reconciliation_exceptions (
  id serial PRIMARY KEY,
  factory_id integer NOT NULL REFERENCES factories(id),
  worker_id integer NOT NULL REFERENCES workers(id),
  from_date date NOT NULL,
  to_date date NOT NULL,
  reason text NOT NULL,
  approved_by_admin_id integer NOT NULL REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sushi_reconciliation_exc_idx ON sushi_reconciliation_exceptions (factory_id, worker_id, from_date, to_date);

-- Початкові базові ролі Sushi
INSERT INTO sushi_roles (code, name, color_badge, default_client_rate, default_worker_rate, is_billable_to_client, display_order)
VALUES
  ('worker', 'Pracownik Fizyczny', '#64748b', 40.00, 28.00, true, 1),
  ('leader', 'Lider', '#3b82f6', 41.50, 29.50, true, 2),
  ('supervisor', 'Brygadzista', '#8b5cf6', 43.00, 31.00, true, 3),
  ('repack', 'Repack', '#06b6d4', 41.50, 29.00, true, 4),
  ('skoczek', 'Skoczek', '#f59e0b', 41.50, 29.00, true, 5),
  ('trainee', 'Uczeń (Wdrożenie)', '#10b981', 0.00, 28.00, false, 6)
ON CONFLICT (code) DO NOTHING;

COMMIT;
