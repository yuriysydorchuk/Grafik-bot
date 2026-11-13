-- Право «чорний список» (кнопка «Не наймати» в профілі) для ролі «Офіс-менеджер» (зголошення #40, рішення
-- власника 13.11.2026). Ідемпотентно: додає cap лише якщо його ще немає.
UPDATE roles SET caps = caps || '["blacklist"]'::jsonb WHERE key = 'office_manager' AND NOT (caps ? 'blacklist');
