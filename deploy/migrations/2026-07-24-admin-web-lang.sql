-- Мова веб-панелі, збережена на сервері (uk|en|ru): вебвʼю Telegram Mini App
-- не тримає localStorage між відкриттями, тож клієнтський вибір постійно злітав.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS web_lang text;
