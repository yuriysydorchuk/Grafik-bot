-- Категоризація фактур коштових (/cost-invoices) тією самою системою категорій,
-- що й витяги (expense_categories + counterparty_rules).
-- Ефективна категорія рахується при читанні: ручна (manual_category) ??
-- правило контрагента по назві постачальника ?? авто-патерн категорії ?? 'other'.
-- У invoices колонка manual_category історично вже є — ALTER на всяк випадок ідемпотентний.

ALTER TABLE ksef_invoices ADD COLUMN IF NOT EXISTS manual_category text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS manual_category text;
