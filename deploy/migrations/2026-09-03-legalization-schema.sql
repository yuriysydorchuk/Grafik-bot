-- Модуль «Легалізація та документи працівників» — фаза 1 (схема). Гілка
-- feature/worker-docs-signing; накат на прод — лише разом з модулем і після
-- явного підтвердження власника. Усі зміни адитивні (ADD COLUMN IF NOT EXISTS /
-- CREATE TABLE IF NOT EXISTS). workers.legal_status / is_student / under_26 /
-- notify_hours НЕ ЧІПАЮТЬСЯ — це живий вхід listy płac (інваріант 02.09.2026).
--
-- Rollback (усе ізольоване; жодних змін значень у наявних колонках):
--   DROP TABLE IF EXISTS document_audit, worker_legality, legal_rules;
--   ALTER TABLE worker_documents DROP COLUMN IF EXISTS valid_from, DROP COLUMN IF EXISTS issued_at,
--     DROP COLUMN IF EXISTS issuer, DROP COLUMN IF EXISTS employer_company_id, DROP COLUMN IF EXISTS case_status,
--     DROP COLUMN IF EXISTS submitted_at, DROP COLUMN IF EXISTS case_number, DROP COLUMN IF EXISTS decision_at,
--     DROP COLUMN IF EXISTS verified_by, DROP COLUMN IF EXISTS verified_at, DROP COLUMN IF EXISTS review_note,
--     DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS replaces_document_id, DROP COLUMN IF EXISTS requested_at,
--     DROP COLUMN IF EXISTS requested_by;
--   ALTER TABLE document_types DROP COLUMN IF EXISTS code, DROP COLUMN IF EXISTS category, DROP COLUMN IF EXISTS grants_stay,
--     DROP COLUMN IF EXISTS grants_work, DROP COLUMN IF EXISTS requires_employer_match, DROP COLUMN IF EXISTS default_validity_days,
--     DROP COLUMN IF EXISTS renewal_lead_days, DROP COLUMN IF EXISTS applies_to_nationalities, DROP COLUMN IF EXISTS is_active,
--     DROP COLUMN IF EXISTS is_system;

-- Каталог типів документів = каталог evidence. Що документ «дає» — прапорці;
-- вимоги/винятки/глобальні дати — legal_rules.
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'other';
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS grants_stay boolean NOT NULL DEFAULT false;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS grants_work boolean NOT NULL DEFAULT false;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS requires_employer_match boolean NOT NULL DEFAULT false;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS default_validity_days integer;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS renewal_lead_days integer;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS applies_to_nationalities jsonb;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS document_types_code_unique ON document_types(code);

-- Документ працівника: факти справи/строків/роботодавця + evidence (верифікація, джерело).
-- `status` лишається як був (present|missing|expired|pending).
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS valid_from date;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS issued_at date;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS issuer text;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS employer_company_id integer REFERENCES companies(id);
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS case_status text;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS submitted_at date;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS case_number text;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS decision_at date;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS verified_by integer REFERENCES admins(id);
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS verified_at timestamp;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'office';
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS replaces_document_id integer REFERENCES worker_documents(id);
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS requested_at timestamp;
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS requested_by integer REFERENCES admins(id);
CREATE INDEX IF NOT EXISTS worker_documents_worker_type_idx ON worker_documents(worker_id, doc_type_id);
CREATE INDEX IF NOT EXISTS worker_documents_expires_present_idx ON worker_documents(expires_at) WHERE status = 'present';
CREATE INDEX IF NOT EXISTS worker_documents_pending_idx ON worker_documents(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS worker_documents_case_idx ON worker_documents(case_status) WHERE case_status IS NOT NULL;

-- Версійовані правила легальності (чинне не редагується — закривається effective_to + нова версія).
CREATE TABLE IF NOT EXISTS legal_rules (
  id serial PRIMARY KEY,
  code text NOT NULL,
  kind text NOT NULL,
  axis text,
  conditions jsonb NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  source text,
  verified_at timestamp,
  verified_by integer REFERENCES admins(id),
  note text,
  is_active boolean NOT NULL DEFAULT true,
  created_by integer REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS legal_rules_code_from_uniq ON legal_rules(code, effective_from);

-- Кеш результату движка (services/legality.ts). Лише derived; можна TRUNCATE без втрат.
CREATE TABLE IF NOT EXISTS worker_legality (
  worker_id integer PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  stay text NOT NULL,
  work text NOT NULL,
  overall text NOT NULL,
  review_required boolean NOT NULL DEFAULT false,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_expiry_at date,
  next_expiry_doc_id integer,
  required_missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  obligations jsonb NOT NULL DEFAULT '[]'::jsonb,
  derived_legal_status text,
  derived_payroll_class text,
  legacy_mapping_requires_review boolean NOT NULL DEFAULT false,
  legacy_mismatch_kind text NOT NULL DEFAULT 'none',
  payroll_hints jsonb,
  input_hash text,
  rules_hash text,
  computed_at timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS worker_legality_overall_idx ON worker_legality(overall);
CREATE INDEX IF NOT EXISTS worker_legality_next_expiry_idx ON worker_legality(next_expiry_at);

-- Журнал дій над документами (дзеркало invoice_audit).
CREATE TABLE IF NOT EXISTS document_audit (
  id serial PRIMARY KEY,
  document_id integer NOT NULL,
  worker_id integer NOT NULL,
  action text NOT NULL,
  changes jsonb,
  admin_id integer,
  admin_name text,
  source text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_audit_doc_idx ON document_audit(document_id, id);
CREATE INDEX IF NOT EXISTS document_audit_worker_idx ON document_audit(worker_id);
