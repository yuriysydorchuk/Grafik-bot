-- KSeF purchases (закупівельні фактури, subjectType=Subject2) alongside sales.
-- Inter-firm invoices appear twice (seller's sale + buyer's purchase), so the
-- unique key becomes (ksef_number, kind) instead of ksef_number alone.
ALTER TABLE ksef_invoices ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'sale';
ALTER TABLE ksef_invoices ADD COLUMN IF NOT EXISTS seller_nip text;
ALTER TABLE ksef_invoices ADD COLUMN IF NOT EXISTS seller_name text;
ALTER TABLE ksef_invoices ADD COLUMN IF NOT EXISTS invoice_hash text;
ALTER TABLE ksef_invoices ADD COLUMN IF NOT EXISTS corrected_hash text;
ALTER TABLE ksef_invoices ADD COLUMN IF NOT EXISTS paid_via text;
ALTER TABLE ksef_invoices DROP CONSTRAINT IF EXISTS ksef_invoices_ksef_number_unique;
ALTER TABLE ksef_invoices DROP CONSTRAINT IF EXISTS ksef_invoices_ksef_number_key;
DROP INDEX IF EXISTS ksef_invoices_ksef_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS ksef_invoices_number_kind_uniq ON ksef_invoices (ksef_number, kind);
