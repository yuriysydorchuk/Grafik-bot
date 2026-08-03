-- Мульти-контрактні фабрики (ANDROS: Klinex + Euro Support): явний прапорець
-- замість виведення з даних працівників — разова підміна людиною іншої фірми
-- чи помилка в профілі не повинні ділити вкладку Обліку годин (ALMIZ, 08.2026).
ALTER TABLE factories ADD COLUMN IF NOT EXISTS multi_firm boolean NOT NULL DEFAULT false;
UPDATE factories SET multi_firm = true WHERE name = 'ANDROS';
