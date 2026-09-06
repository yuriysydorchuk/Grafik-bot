-- Модуль «Задачі», батч 4: сторінка «Календар працівників» (/workers-calendar).
-- Ключ уже в каталозі PAGE_KEYS; ролям з доступом до /workers відкриваємо й календар.
UPDATE roles SET pages = pages || '["/workers-calendar"]'::jsonb WHERE NOT (pages ? '/workers-calendar') AND (pages ? '/workers');
