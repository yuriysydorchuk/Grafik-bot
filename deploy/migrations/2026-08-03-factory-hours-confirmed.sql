-- Підтвердження розбіжності «рапорт ↔ години фабрики» в Обліку годин:
-- адмін перевірив і каже «все ок» → рядок світиться зеленим, з «лише помилки»
-- в Excel виключається. Скидається автоматично при зміні годин фабрики.
ALTER TABLE factory_hours ADD COLUMN IF NOT EXISTS confirmed boolean NOT NULL DEFAULT false;
