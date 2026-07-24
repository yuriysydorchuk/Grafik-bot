-- Сводна 2.0 видалена повністю (джерело правди — перша сводна, /svodni):
-- код, сторінка, роутер і таблиці. Дані svodni2 більше не потрібні.
DROP TABLE IF EXISTS svodni2_rows;
DROP TABLE IF EXISTS svodni2_columns;
DROP TABLE IF EXISTS svodni2_locks;
DELETE FROM settings WHERE key = 'svodni2_min_rates';
-- прибрати сторінку зі списків доступу ролей
UPDATE roles
SET pages = (
  SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
  FROM jsonb_array_elements(pages) AS p
  WHERE p <> '"/svodni2"'::jsonb
)
WHERE pages @> '["/svodni2"]'::jsonb;
