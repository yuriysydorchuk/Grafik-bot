-- Архів фактур переїжджає в папки офісного акаунта (рішення власника 29.09.2026):
--   закупівлі → FAKTURY (office.eurosupp): <рік>/M<міс>.<рр>/<ФІРМА>/[Skany|Proformy]
--   продажі   → FAKTURY SPRZEDAŻOWI (office.eurosupp): M<міс>.<рр>/<ФІРМА>
-- Акаунту Юрія (OAuth застосунку) виданий доступ на редагування обох папок.
INSERT INTO settings (key, value) VALUES
  ('drive_faktury_cost_folder_id',  '1i5MKfQNmdZXx08A7Rw1oMLUWWBM63chC'),
  ('drive_faktury_sales_folder_id', '14By6hEpErs9DxIyn8_68PQNfqde9w0nF')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
