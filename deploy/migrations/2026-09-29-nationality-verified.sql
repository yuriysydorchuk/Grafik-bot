-- Ручне підтвердження громадянства (29.09.2026): «поляк/ЄС» із документами лише для іноземців
-- (TRC, віза, zezwolenie) — движок легальності не застосовує правило громадянства, поки офіс
-- не підтвердить; підтвердження скидається при зміні nationality.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS nationality_verified_at timestamp;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS nationality_verified_by integer;
