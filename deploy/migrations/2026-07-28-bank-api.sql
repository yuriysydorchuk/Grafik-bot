-- Open banking (Enable Banking PSD2 API): згоди, рахунки, джерело транзакції.
-- API-рядки живуть у bank_transactions з source='api' і заміщаються MT940-імпортом.

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'mt940';

CREATE TABLE IF NOT EXISTS bank_api_consents (
  id serial PRIMARY KEY,
  session_id text NOT NULL UNIQUE,
  aspsp_name text NOT NULL,
  aspsp_country text NOT NULL DEFAULT 'PL',
  company_id integer REFERENCES companies(id),
  valid_until timestamp NOT NULL,
  revoked_at timestamp,
  expiry_warned_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_api_accounts (
  id serial PRIMARY KEY,
  consent_id integer NOT NULL REFERENCES bank_api_consents(id) ON DELETE CASCADE,
  uid text NOT NULL,
  iban text,
  holder_name text,
  product text,
  currency text,
  company_id integer REFERENCES companies(id),
  last_booked_balance real,
  last_available_balance real,
  balance_at timestamp,
  last_sync_at timestamp,
  last_tx_date date
);

CREATE INDEX IF NOT EXISTS bank_transactions_source_idx ON bank_transactions (source) WHERE source <> 'mt940';
