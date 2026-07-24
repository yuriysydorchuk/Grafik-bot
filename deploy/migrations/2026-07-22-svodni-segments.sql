-- Сегменти всередині місяця у сводній: людина з різними умовами в різні періоди
-- місяця (до 14-го працівник, з 14-го лідер) показується батьківським рядком із
-- сумами + рядками-сегментами зі своїми ставками/статусами/годинами.
-- segment_of = id батьківського рядка (NULL = звичайний/батьківський рядок);
-- segment_from/segment_to = період сегмента в місяці; segment_label = підпис
-- («до зміни», назва посади тощо).
ALTER TABLE svodni_rows ADD COLUMN IF NOT EXISTS segment_of integer REFERENCES svodni_rows(id) ON DELETE CASCADE;
ALTER TABLE svodni_rows ADD COLUMN IF NOT EXISTS segment_from date;
ALTER TABLE svodni_rows ADD COLUMN IF NOT EXISTS segment_to date;
ALTER TABLE svodni_rows ADD COLUMN IF NOT EXISTS segment_label text;
CREATE INDEX IF NOT EXISTS svodni_rows_segment_of_idx ON svodni_rows(segment_of) WHERE segment_of IS NOT NULL;
