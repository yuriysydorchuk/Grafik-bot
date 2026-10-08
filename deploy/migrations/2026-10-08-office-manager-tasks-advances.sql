-- Офіс-менеджер: задачі, календар працівників, залічки, запрошення/звільнення (08.10.2026).
-- Ідемпотентно: додає лише відсутні сторінки/права до ролі office_manager (інші ролі не чіпає).
-- Нові caps workerLifecycle / advances існують у каталозі lib/roles.ts обох пакетів.
UPDATE roles SET pages = pages || '["/tasks"]'::jsonb WHERE key = 'office_manager' AND NOT pages ? '/tasks';
UPDATE roles SET pages = pages || '["/workers-calendar"]'::jsonb WHERE key = 'office_manager' AND NOT pages ? '/workers-calendar';
UPDATE roles SET pages = pages || '["/advances"]'::jsonb WHERE key = 'office_manager' AND NOT pages ? '/advances';
UPDATE roles SET caps = caps || '["workerLifecycle"]'::jsonb WHERE key = 'office_manager' AND NOT caps ? 'workerLifecycle';
UPDATE roles SET caps = caps || '["advances"]'::jsonb WHERE key = 'office_manager' AND NOT caps ? 'advances';
-- Бот-пуші про задачі НЕ вмикаємо: кнопки задач у боті йдуть через getAdmin, який скоуп-адміна не бачить.
