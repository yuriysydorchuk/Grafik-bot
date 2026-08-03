-- Сводні: ручна колонка «Замітки» біля імені (робочі нотатки, не фінансове поле).
-- Переживає синк через carry-over по ключу вкладка+імʼя (svodniSync.ts).
ALTER TABLE svodni_rows ADD COLUMN IF NOT EXISTS note text;
