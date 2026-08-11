-- Платний довіз: налаштування фабрики для авторозрахунку знять за довіз
-- (вкладка Транспорт → «Зняття за довіз»; сума = min(зміни × ціна, ліміт/міс).
ALTER TABLE factories ADD COLUMN IF NOT EXISTS paid_transport boolean NOT NULL DEFAULT false;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS transport_fee_per_shift real;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS transport_fee_month_cap real;
