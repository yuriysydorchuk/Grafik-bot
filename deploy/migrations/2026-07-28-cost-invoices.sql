-- Модуль «Фактури коштові» (/cost-invoices): ручне внесення на сайті + скан з бота.
-- Рядки живуть у наявній таблиці invoices поруч зі sheet-синком (перехідний період).

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'sheet';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seller_nip text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS file_path text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by integer REFERENCES admins(id);

-- наявні ручні рядки панелі (tab_name='manual') стають source='manual'
UPDATE invoices SET source = 'manual' WHERE tab_name = 'manual' AND source = 'sheet';
