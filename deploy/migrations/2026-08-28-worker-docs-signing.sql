-- Модуль «Документи працівників і онлайн-підписання умов» (розробка в гілці
-- feature/worker-docs-signing, накат на прод — лише після повної готовності
-- модуля). Усі зміни адитивні: нові таблиці + один ADD COLUMN IF NOT EXISTS.

-- Анкета працівника (паспорт + адмін-дані для генерації umowa zlecenie).
CREATE TABLE IF NOT EXISTS worker_questionnaires (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft',
  passport_number text,
  passport_country text,
  passport_issued_at date,
  passport_expires_at date,
  birth_place text,
  sex text,
  citizenship text,
  address_registered text,
  address_pl text,
  bank_iban text,
  tax_office text,
  nfz_branch text,
  is_student boolean NOT NULL DEFAULT false,
  has_other_employment boolean NOT NULL DEFAULT false,
  other_employment_note text,
  emergency_contact text,
  ocr_raw jsonb,
  ocr_doc_id integer REFERENCES worker_documents(id),
  submitted_at timestamp,
  verified_by integer REFERENCES admins(id),
  verified_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_questionnaires_worker_uniq ON worker_questionnaires(worker_id);

-- Набори шаблонів (умова + załączniki).
CREATE TABLE IF NOT EXISTS contract_template_sets (
  id serial PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contract_templates (
  id serial PRIMARY KEY,
  set_id integer NOT NULL REFERENCES contract_template_sets(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  kind text NOT NULL,
  title text NOT NULL,
  file_path text,
  file_name text,
  file_mime text,
  fields jsonb NOT NULL DEFAULT '[]',
  signature_spots jsonb NOT NULL DEFAULT '[]',
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_templates_set_idx ON contract_templates(set_id);

-- Умова (umowa zlecenie), версіонована. supersedes_id — self-FK, ланцюг історії
-- при зміні фабрики/продовженні.
CREATE TABLE IF NOT EXISTS contracts (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id),
  factory_id integer REFERENCES factories(id),
  template_set_id integer REFERENCES contract_template_sets(id),
  status text NOT NULL DEFAULT 'draft',
  date_from date,
  date_to date,
  supersedes_id integer REFERENCES contracts(id),
  data jsonb NOT NULL DEFAULT '{}',
  generated_at timestamp,
  approved_by integer REFERENCES admins(id),
  approved_at timestamp,
  sent_at timestamp,
  first_viewed_at timestamp,
  signed_at timestamp,
  superseded_at timestamp,
  decline_reason text,
  expiry_warned_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contracts_worker_idx ON contracts(worker_id);
CREATE INDEX IF NOT EXISTS contracts_status_idx ON contracts(status);
CREATE INDEX IF NOT EXISTS contracts_supersedes_idx ON contracts(supersedes_id);

CREATE TABLE IF NOT EXISTS contract_files (
  id serial PRIMARY KEY,
  contract_id integer NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  template_id integer REFERENCES contract_templates(id),
  sort_order integer NOT NULL DEFAULT 0,
  title text NOT NULL,
  unsigned_path text,
  unsigned_sha256 text,
  signed_path text,
  signed_sha256 text,
  page_count integer,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_files_contract_idx ON contract_files(contract_id);

CREATE TABLE IF NOT EXISTS signature_tokens (
  id serial PRIMARY KEY,
  token text NOT NULL UNIQUE,
  contract_id integer NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  expires_at timestamp NOT NULL,
  used_at timestamp,
  revoked_at timestamp,
  view_count integer NOT NULL DEFAULT 0,
  created_by integer REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signature_tokens_contract_idx ON signature_tokens(contract_id);

-- Immutable аудит-журнал підписання (доказова база простого е-підпису).
CREATE TABLE IF NOT EXISTS signature_events (
  id serial PRIMARY KEY,
  contract_id integer NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  token_id integer REFERENCES signature_tokens(id),
  event text NOT NULL,
  at timestamp NOT NULL DEFAULT now(),
  ip text,
  user_agent text,
  device text,
  geo text,
  doc_sha256 text,
  extra jsonb
);
CREATE INDEX IF NOT EXISTS signature_events_contract_idx ON signature_events(contract_id);

-- Дедуп cron-нагадувань про закінчення строку документа (bank_api_consents.expiry_warned_at pattern).
ALTER TABLE worker_documents ADD COLUMN IF NOT EXISTS expiry_warned_at timestamp;
