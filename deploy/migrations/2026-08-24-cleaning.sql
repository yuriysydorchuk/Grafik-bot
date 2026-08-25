-- Розділ «Прибирання» (/cleaning, cap `cleaning`): реєстр вспульнот (проєктів),
-- винагродження вільним списком імен, маркери видатків на фактурах і категоріях каси.
CREATE TABLE IF NOT EXISTS cleaning_projects (
  id serial PRIMARY KEY,
  name text NOT NULL,
  nip text UNIQUE,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cleaning_payrolls (
  id serial PRIMARY KEY,
  period_month text NOT NULL,
  name text NOT NULL,
  base real NOT NULL DEFAULT 0,
  hours real,
  rate real,
  components jsonb NOT NULL DEFAULT '[]',
  total real NOT NULL DEFAULT 0,
  konto real NOT NULL DEFAULT 0,
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cleaning_payroll_projects (
  id serial PRIMARY KEY,
  payroll_id integer NOT NULL REFERENCES cleaning_payrolls(id) ON DELETE CASCADE,
  project_id integer NOT NULL REFERENCES cleaning_projects(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cleaning_payroll_projects_uniq ON cleaning_payroll_projects (payroll_id, project_id);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cleaning boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cleaning_project_id integer REFERENCES cleaning_projects(id);
ALTER TABLE ksef_invoices ADD COLUMN IF NOT EXISTS cleaning_project_id integer REFERENCES cleaning_projects(id);
ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS cleaning boolean NOT NULL DEFAULT false;

-- Бекфіл авто-позначки постачальників прибирання (дзеркало isCleaningSupplier у services/ksef.ts):
-- PELIA Włodzimierz Nepelak (NIP 9462635737, директор по прибираннях, B2B) і FloRyś (матеріали)
UPDATE ksef_invoices SET segment = 'cleaning'
  WHERE kind = 'purchase' AND segment <> 'cleaning'
    AND (replace(coalesce(seller_nip, ''), '-', '') = '9462635737'
         OR seller_name ILIKE '%nepelak%' OR seller_name ILIKE '%floryś%' OR seller_name ILIKE '%florys%');
UPDATE invoices SET cleaning = true
  WHERE cleaning = false
    AND (counterparty ILIKE '%nepelak%' OR counterparty ILIKE '%floryś%' OR counterparty ILIKE '%florys%');
