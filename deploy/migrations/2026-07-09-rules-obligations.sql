-- Counterparty→category rules + receivables/payables ledger
CREATE TABLE IF NOT EXISTS counterparty_rules (
  id serial PRIMARY KEY,
  pattern text NOT NULL,
  category text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS obligations (
  id serial PRIMARY KEY,
  company_id integer REFERENCES companies(id),
  direction text NOT NULL,
  counterparty text NOT NULL,
  description text,
  amount real NOT NULL,
  due_date date,
  status text NOT NULL DEFAULT 'open',
  settled_at date,
  note text,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamp NOT NULL DEFAULT now()
);
-- Cost invoices mirror (Faktury Kosztowe sheets)
CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  company_id integer REFERENCES companies(id),
  period_month text NOT NULL,
  doc_type text,
  issue_date date,
  number text,
  amount real NOT NULL,
  status_raw text,
  unpaid boolean NOT NULL DEFAULT false,
  due_date date,
  counterparty text,
  category text,
  paid_date date,
  tab_name text NOT NULL,
  sort_idx integer NOT NULL DEFAULT 0,
  imported_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_month_idx ON invoices (period_month, company_id);
-- when the debt economically arose (an obligation entered in July for June VAT counts at June's month-end)
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS arisen_date date NOT NULL DEFAULT CURRENT_DATE;
-- Panel-side overrides for mirrored invoices (survive sheet re-sync) + manual invoices
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS manual_status text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS manual_paid_date date;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS manual_category text;
-- P&L module: accrual lines per month (imported history + manual + future KSeF/payroll)
CREATE TABLE IF NOT EXISTS pnl_entries (
  id serial PRIMARY KEY,
  period_month text NOT NULL,
  section text NOT NULL,
  label text NOT NULL,
  amount real NOT NULL,
  amount_gross real,
  segment text NOT NULL DEFAULT 'main',
  source text NOT NULL DEFAULT 'manual',
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pnl_entries_month_idx ON pnl_entries (period_month, section);
