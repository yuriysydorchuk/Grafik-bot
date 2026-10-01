-- Кольорове виділення рядків на /cost-invoices (прохання кшєнгової, 01.10.2026).
-- Ключ палітри (yellow|green|blue|red|purple|orange|gray), NULL = без кольору.
-- Одна й та сама позначка для трьох джерел списку: KSeF, локальні фактури, записи умов.
ALTER TABLE invoices          ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE ksef_invoices     ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE agreement_charges ADD COLUMN IF NOT EXISTS color text;
