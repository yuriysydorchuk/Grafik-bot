-- KSeF sales invoices mirror (revenue per client + payment tracking)
CREATE TABLE IF NOT EXISTS ksef_invoices (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id),
  ksef_number text NOT NULL UNIQUE,
  invoice_number text NOT NULL,
  issue_date date NOT NULL,
  invoicing_date date,
  buyer_nip text,
  buyer_name text,
  net real NOT NULL,
  vat real NOT NULL DEFAULT 0,
  gross real NOT NULL,
  currency text NOT NULL DEFAULT 'PLN',
  invoice_type text,
  revenue_month text NOT NULL,
  client_label text,
  segment text NOT NULL DEFAULT 'main',
  paid_date date,
  paid_txn_id integer,
  manual_status text,
  manual_paid_date date,
  imported_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ksef_invoices_revenue_month_idx ON ksef_invoices (revenue_month);
CREATE INDEX IF NOT EXISTS ksef_invoices_issue_idx ON ksef_invoices (issue_date);
