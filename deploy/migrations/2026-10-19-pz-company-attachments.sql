-- Залучники фірми до powiadomienia PSZ-PPWPU (19.10.2026): oświadczenie «88Z» по фірмі (по два PDF, щомісяця),
-- робот praca.gov.pl додає їх до кожної подачі разом зі сканом паспорта. Файли — UPLOADS_ROOT/pz-company-attachments/<companyId>/.
CREATE TABLE IF NOT EXISTS pz_company_attachments (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label text NOT NULL,
  file_name text NOT NULL,
  file_path text NOT NULL,
  period text,
  uploaded_by integer REFERENCES admins(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pz_company_attachments_company_idx ON pz_company_attachments(company_id);
