-- Довідник контрагентів (клієнти/постачальники: канонічна назва, NIP, аліаси, IBAN-и)
-- + IBAN-и працівників (щоб ЗП/аванси без ключових слів не падали в «Інше»).

CREATE TABLE IF NOT EXISTS counterparties (
  id serial PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'other',
  nip text UNIQUE,
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS counterparty_aliases (
  id serial PRIMARY KEY,
  counterparty_id integer NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  alias text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS counterparty_accounts (
  id serial PRIMARY KEY,
  counterparty_id integer NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  iban text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS worker_bank_accounts (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  iban text NOT NULL UNIQUE,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS counterparty_id integer REFERENCES counterparties(id);
CREATE INDEX IF NOT EXISTS bank_transactions_counterparty_idx ON bank_transactions (counterparty_id) WHERE counterparty_id IS NOT NULL;
