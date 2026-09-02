-- {%Wynagrodzenie%} у Umowa (worker-docs-signing) — окрема ставка для умови,
-- не rateBrutto (payroll). NULL → мінімальна крайова (settings ksieg_min_rates).
ALTER TABLE factories ADD COLUMN IF NOT EXISTS contract_rate_brutto real;

-- Знімок ставки, що реально пішла в конкретний пакет документів (пер-людини
-- override при генерації) — щоб дата-only перегенерація draft не губила його.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS contract_rate_brutto real;
