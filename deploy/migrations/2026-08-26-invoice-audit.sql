-- Журнал змін фактур (/cost-invoices, /ksef): хто додав/змінив/затвердив оплату.
-- admin_name — снапшот (переживає перейменування/видалення адміна).
CREATE TABLE IF NOT EXISTS invoice_audit (
  id serial PRIMARY KEY,
  origin text NOT NULL,                       -- ksef | local (invoices)
  invoice_id integer NOT NULL,
  action text NOT NULL,                       -- created | updated | file | deleted
  changes jsonb,                              -- [{field, from, to}] для updated
  admin_id integer,
  admin_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_audit_inv_idx ON invoice_audit (origin, invoice_id, id DESC);
