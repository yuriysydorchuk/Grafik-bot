-- Бібліотека шаблонів документів (§2.2 плану worker-docs-signing) — заміна
-- файл-аплоадного contract_template_sets/contract_templates (pdf-lib AcroForm)
-- на HTML {%Плейсхолдер%}-бібліотеку з мовами й scope (all|company|factory),
-- рушій генерації переходить на Puppeteer HTML→PDF.
-- Локально/тест-БД лише, поки модуль не готовий (CLAUDE.md, план §11).

CREATE TABLE IF NOT EXISTS document_templates (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  title text NOT NULL,
  is_base boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'all',
  scope_company_ids jsonb NOT NULL DEFAULT '[]',
  scope_factory_ids jsonb NOT NULL DEFAULT '[]',
  position_id integer REFERENCES positions(id),
  body jsonb NOT NULL DEFAULT '{}',
  lang_is_manual jsonb NOT NULL DEFAULT '{}',
  lang_source_hash jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_by integer REFERENCES admins(id),
  updated_by integer REFERENCES admins(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- contract_files.template_id: перецілення FK з contract_templates на document_templates
ALTER TABLE contract_files DROP CONSTRAINT IF EXISTS contract_files_template_id_fkey;
ALTER TABLE contract_files ADD CONSTRAINT contract_files_template_id_fkey
  FOREIGN KEY (template_id) REFERENCES document_templates(id);

-- contracts: template_set_id більше не потрібен (документи пакета резолвляться
-- динамічно через resolveDocumentSet, а не через один зафіксований набір);
-- payout_method — знімок способу виплати на момент генерації сталого пакету.
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_template_set_id_fkey;
ALTER TABLE contracts DROP COLUMN IF EXISTS template_set_id;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS payout_method text;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS worker_signature_path text;

-- worker_questionnaires: нові поля з реального довідника плейсхолдерів HrAppka
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS seria_i_numer_dowodu text;
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS payout_method text NOT NULL DEFAULT 'konto';
ALTER TABLE worker_questionnaires ADD COLUMN IF NOT EXISTS waives_tax_advance boolean NOT NULL DEFAULT false;

-- Старий файл-аплоадний рушій — більше не використовується.
DROP TABLE IF EXISTS contract_templates;
DROP TABLE IF EXISTS contract_template_sets;
