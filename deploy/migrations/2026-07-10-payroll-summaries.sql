-- Payroll summaries («Зведені ЗП»): monthly per-region workbooks.
-- Registry of source spreadsheets + parsed per-factory aggregates,
-- ZUS/cash split rows and office payroll rows (kept separate).

CREATE TABLE IF NOT EXISTS payroll_sources (
  id serial PRIMARY KEY,
  period_month text NOT NULL,
  region text NOT NULL,
  firm text,
  spreadsheet_id text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'gsheet',
  title text,
  last_sync_at timestamp,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_folders (
  id serial PRIMARY KEY,
  folder_id text NOT NULL UNIQUE,
  title text,
  last_sync_at timestamp,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_factory_months (
  id serial PRIMARY KEY,
  source_id integer NOT NULL REFERENCES payroll_sources(id),
  period_month text NOT NULL,
  region text NOT NULL,
  factory text NOT NULL,
  firm text,
  tab_name text,
  hours real,
  do_zaplaty real,
  zaliczki real,
  zaliczka_bd real,
  premia real,
  odziez real,
  hostel real,
  dojazd real,
  kary real,
  workers integer,
  students integer,
  over26 integer,
  main_brutto real,
  main_netto real,
  main_taxed_brutto real,
  block_brutto real,
  block_netto real,
  block_taxed_brutto real,
  gotowka real,
  block_hours_actual real,
  block_hours_declared real,
  imported_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payroll_factory_months_month_idx ON payroll_factory_months (period_month);

CREATE TABLE IF NOT EXISTS payroll_cash_rows (
  id serial PRIMARY KEY,
  source_id integer NOT NULL REFERENCES payroll_sources(id),
  period_month text NOT NULL,
  region text NOT NULL,
  tab_name text NOT NULL,
  name text NOT NULL,
  hours_actual real,
  hours_declared real,
  brutto real,
  netto real,
  gotowka real,
  full_netto real,
  konto real,
  sort_idx integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS payroll_cash_rows_month_idx ON payroll_cash_rows (period_month);

CREATE TABLE IF NOT EXISTS payroll_name_matches (
  id serial PRIMARY KEY,
  bank_key text NOT NULL UNIQUE,
  counterparty text,
  person_key text NOT NULL,
  person_name text,
  kind text NOT NULL DEFAULT 'worker',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_office_rows (
  id serial PRIMARY KEY,
  source_id integer NOT NULL REFERENCES payroll_sources(id),
  period_month text NOT NULL,
  region text NOT NULL,
  firm text NOT NULL,
  section text,
  name text NOT NULL,
  status text,
  hours text,
  stawka text,
  brutto real,
  umowa_od text,
  umowa_do text,
  koniec_studiow text,
  zaswiadczenie text,
  sort_idx integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS payroll_office_rows_month_idx ON payroll_office_rows (period_month);

-- web page key for the new «Зарплати» page (owner sees everything by code)
