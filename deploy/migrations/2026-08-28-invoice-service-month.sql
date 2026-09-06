-- Фактури витрат: «за який місяць» послуга (service_month, YYYY-MM).
-- Реєстр веде фактуру у вкладці місяця оплати; P&L по містах відносить
-- хостельні та city-фактури за місяцем послуги: coalesce(service_month, period_month).
-- Заповнюється авто-розбором номера фактури при синку + вручну з панелі.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS service_month text;

-- бекфіл з номера: «1/06/2026», «142/07/2026» → місяць/рік; «2026/08/HOUSE/…» → рік/місяць
UPDATE invoices SET service_month = (regexp_match(number, '^\d{1,4}/(\d{2})/(\d{4})'))[2] || '-' || (regexp_match(number, '^\d{1,4}/(\d{2})/(\d{4})'))[1]
  WHERE service_month IS NULL AND number ~ '^\d{1,4}/(0[1-9]|1[0-2])/20[2-3][0-9]';
UPDATE invoices SET service_month = (regexp_match(number, '^(\d{4})/(\d{2})/'))[1] || '-' || (regexp_match(number, '^(\d{4})/(\d{2})/'))[2]
  WHERE service_month IS NULL AND number ~ '^20[2-3][0-9]/(0[1-9]|1[0-2])/';
