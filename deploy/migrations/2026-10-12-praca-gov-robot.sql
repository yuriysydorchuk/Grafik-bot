-- Робот подачі powiadomienia PSZ-PPWPU на praca.gov.pl (12.10.2026, етап 1: акаунти + вхід).
-- Акаунти profilu zaufanego адмінів (пароль — шифротекст, ключ PZ_SECRET), журнал подач,
-- та поля даних, яких форма вимагає, а в базі не було: код zawodu KZiS у посадах,
-- структурована адреса фабрики (TERYT), чисельність працівників і KRAZ фірми. Ідемпотентно.
CREATE TABLE IF NOT EXISTS pz_accounts (
  id serial PRIMARY KEY,
  admin_id integer NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  label text,
  login text NOT NULL,
  password_enc text NOT NULL,
  company_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  context_name text,
  signer_function text,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamp,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ua_submissions (
  id serial PRIMARY KEY,
  kind text NOT NULL DEFAULT 'submission',
  account_id integer REFERENCES pz_accounts(id) ON DELETE SET NULL,
  admin_id integer REFERENCES admins(id) ON DELETE SET NULL,
  worker_id integer REFERENCES workers(id) ON DELETE SET NULL,
  company_id integer REFERENCES companies(id) ON DELETE SET NULL,
  task_id integer,
  status text NOT NULL DEFAULT 'queued',
  step text,
  payload jsonb,
  error text,
  screenshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmation_no text,
  document_id integer,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp
);
CREATE INDEX IF NOT EXISTS ua_submissions_account_status_idx ON ua_submissions (account_id, status);

ALTER TABLE positions ADD COLUMN IF NOT EXISTS kzis_code text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS headcount_employment integer;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS headcount_civil integer;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS kraz text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS addr_postal_code text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS addr_wojewodztwo text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS addr_powiat text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS addr_gmina text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS addr_miejscowosc text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS addr_street text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS addr_house_no text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS addr_apt_no text;

-- 13.10.2026: файл pełnomocnictwa для підписанта-pełnomocnika (форма вимагає załącznik до галочки)
ALTER TABLE pz_accounts ADD COLUMN IF NOT EXISTS poa_file_path text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_phone text;
ALTER TABLE ua_submissions ADD COLUMN IF NOT EXISTS preview_file text;
-- 13.10.2026: назва посади/KZiS для powiadomienia по фабриці та по посаді на фабриці
ALTER TABLE factories ADD COLUMN IF NOT EXISTS ua_stanowisko text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS ua_kzis_code text;
ALTER TABLE factory_positions ADD COLUMN IF NOT EXISTS ua_stanowisko text;
ALTER TABLE factory_positions ADD COLUMN IF NOT EXISTS kzis_code text;
