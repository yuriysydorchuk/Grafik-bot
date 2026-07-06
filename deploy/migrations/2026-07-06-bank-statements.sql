-- Bank statements module: raw MT940 transactions + statement balances,
-- companies extended with legal-entity fields (NIP).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS nip text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

UPDATE companies SET legal_name='Eurosupport Group',       nip='9462698100', is_active=true WHERE name='ES';
UPDATE companies SET legal_name='Eurosupport Outsourcing', nip='7123441567', is_active=true WHERE name='ESO';
UPDATE companies SET legal_name='Klinex',                  nip='7123438022', is_active=true WHERE name='Klinex';
INSERT INTO companies (name, legal_name, nip, is_active)
  SELECT 'RS', 'Roman Sydorchuk', '9462680666', true WHERE NOT EXISTS (SELECT 1 FROM companies WHERE name='RS');
INSERT INTO companies (name, legal_name, nip, is_active)
  SELECT 'TS', 'Tetiana Sydorchuk', NULL, false WHERE NOT EXISTS (SELECT 1 FROM companies WHERE name='TS');

CREATE TABLE IF NOT EXISTS bank_transactions (
  id serial PRIMARY KEY,
  company_id integer REFERENCES companies(id),
  entity_folder text,
  account text,
  statement_no text,
  file_name text,
  value_date date NOT NULL,
  booking_date date,
  direction text NOT NULL,
  amount real NOT NULL,
  currency text NOT NULL DEFAULT 'PLN',
  counterparty text,
  counterparty_account text,
  title text,
  tx_type text,
  bank_ref text,
  dedup_hash text NOT NULL,
  imported_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_dedup_uniq ON bank_transactions(dedup_hash);
CREATE INDEX IF NOT EXISTS bank_transactions_company_date_idx ON bank_transactions(company_id, value_date);

CREATE TABLE IF NOT EXISTS bank_statements (
  id serial PRIMARY KEY,
  company_id integer REFERENCES companies(id),
  account text, statement_no text, file_name text,
  opening_date date, opening_balance real, closing_date date, closing_balance real,
  closing_derived boolean NOT NULL DEFAULT false,
  dedup_hash text NOT NULL, imported_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_statements_dedup_uniq ON bank_statements(dedup_hash);
CREATE INDEX IF NOT EXISTS bank_statements_acct_idx ON bank_statements(company_id, account, closing_date);
