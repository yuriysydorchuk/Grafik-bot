-- Manual re-categorization of bank transactions + office cash box (сейф) ledger.
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS manual_category text;
CREATE TABLE IF NOT EXISTS cash_entries (
  id serial PRIMARY KEY,
  company_id integer REFERENCES companies(id),
  period_month text NOT NULL,
  entry_date date,
  kind text NOT NULL,
  amount real NOT NULL,
  description text,
  note text,
  tab_name text NOT NULL,
  sort_idx integer NOT NULL DEFAULT 0,
  imported_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_entries_month_idx ON cash_entries(company_id, period_month);
