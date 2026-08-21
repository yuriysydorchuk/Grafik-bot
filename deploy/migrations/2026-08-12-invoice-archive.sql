-- Фактури: спосіб оплати (переказ/готівка), чекбокс «рапорт готівковий»,
-- термін оплати для KSeF-рядків і Drive-архів (Faktury kosztowe / sprzedażowe).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_method text,                          -- przelew | gotowka | NULL = авто
  ADD COLUMN IF NOT EXISTS cash_report boolean NOT NULL DEFAULT false,   -- «рапорт готівковий» (нотатка кшєнгової)
  ADD COLUMN IF NOT EXISTS drive_file_id text,                           -- файл фактури на Google Drive
  ADD COLUMN IF NOT EXISTS drive_error text,                             -- чому файла нема на Drive
  ADD COLUMN IF NOT EXISTS drive_synced_at timestamp;

ALTER TABLE ksef_invoices
  ADD COLUMN IF NOT EXISTS due_date date,                                -- термін оплати (з XML фактури)
  ADD COLUMN IF NOT EXISTS payment_method text,                          -- przelew | gotowka | NULL = авто
  ADD COLUMN IF NOT EXISTS payment_method_xml text,                      -- метод з XML (FormaPlatnosci) — авто-фолбек
  ADD COLUMN IF NOT EXISTS cash_report boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS xml_path text,                                -- локальна копія XML (uploads/ksef-xml/)
  ADD COLUMN IF NOT EXISTS drive_file_id text,
  ADD COLUMN IF NOT EXISTS drive_error text,
  ADD COLUMN IF NOT EXISTS drive_synced_at timestamp;

-- 13.08: PDF-візуалізація поряд з XML (лінк веде на PDF)
ALTER TABLE ksef_invoices
  ADD COLUMN IF NOT EXISTS drive_pdf_id text;
