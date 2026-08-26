-- Тип банковості PSD2-згоди: business (корпоративний банкінг) | personal
-- (роздрібний/приватний — фірмові конта mBank малих фірм живуть саме там).
-- Вибирається при підключенні банку; «Поновити» реюзає збережений тип.
ALTER TABLE bank_api_consents ADD COLUMN IF NOT EXISTS psu_type text NOT NULL DEFAULT 'business';
