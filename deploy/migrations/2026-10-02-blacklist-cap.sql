-- Cap `blacklist` (02.10.2026): вносити людей у чорний список з причиною — окремо від
-- deleteWorkers (власник), яким досі гейтилось і внесення, і зняття. Графіковій (scheduler)
-- даємо право вносити і прибирати (рішення власника 02.10.2026).
-- Ідемпотентно: ролі, де cap уже є, не чіпаються.
UPDATE roles SET caps = caps || '["blacklist"]'::jsonb
  WHERE key = 'scheduler' AND NOT caps ? 'blacklist';
