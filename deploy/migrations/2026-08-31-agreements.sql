-- «Умови» (агрименти/договори) на /cost-invoices: періодичні або одноразові
-- зобов'язання по фірмі, окремі від разових фактур. one_time/fixed_term/indefinite,
-- щомісячна генерація agreement_charges (services/agreementConditions.ts), журнал
-- дій — agreement_audit (дзеркало invoice_audit).
CREATE TABLE IF NOT EXISTS agreement_conditions (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  title text NOT NULL,
  counterparty text,
  category text NOT NULL,
  kind text NOT NULL,                          -- one_time | fixed_term | indefinite
  amount real NOT NULL,
  vat_included boolean NOT NULL DEFAULT true,
  vat_rate real NOT NULL DEFAULT 23,
  gross_amount real NOT NULL,
  city text,
  start_month text NOT NULL,                   -- YYYY-MM
  end_month text,                              -- YYYY-MM; NULL = indefinite (ще не завершена)
  file_path text,
  drive_file_id text,
  drive_error text,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_by integer REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agreement_conditions_company_idx ON agreement_conditions (company_id, active);

CREATE TABLE IF NOT EXISTS agreement_charges (
  id serial PRIMARY KEY,
  agreement_id integer NOT NULL REFERENCES agreement_conditions(id) ON DELETE CASCADE,
  month text NOT NULL,                         -- YYYY-MM
  amount real NOT NULL,
  note text,
  source text NOT NULL DEFAULT 'auto',         -- auto | manual-edit
  status text NOT NULL DEFAULT 'active',       -- active | deleted (soft — регенерація не воскрешає)
  created_by integer REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, month)
);
CREATE INDEX IF NOT EXISTS agreement_charges_month_idx ON agreement_charges (month, status);

CREATE TABLE IF NOT EXISTS agreement_audit (
  id serial PRIMARY KEY,
  entity text NOT NULL,                        -- condition | charge
  entity_id integer NOT NULL,
  action text NOT NULL,                        -- created | updated | file | deleted
  changes jsonb,
  admin_id integer,
  admin_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agreement_audit_entity_idx ON agreement_audit (entity, entity_id, id DESC);
