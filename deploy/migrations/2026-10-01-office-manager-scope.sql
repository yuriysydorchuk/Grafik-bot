-- Роль «Офіс-менеджер» + доступ по містах/фабриках + делеговані запрошення (01.10.2026).
--
-- Скоуп — на ЛЮДИНІ (admins), не на ролі: роль одна, міста різні. Обидва списки порожні =
-- доступ до всього (як було). Місто = factories.city (нова фабрика в місті потрапляє в
-- доступ сама). Адмін зі скоупом проходить лише скоуп-свідомі ендпойнти (lib/scope.ts).
ALTER TABLE admins ADD COLUMN IF NOT EXISTS scope_cities jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS scope_factory_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Які ролі цей адмін може видавати запрошеннями (видає лише головний адмін).
ALTER TABLE admins ADD COLUMN IF NOT EXISTS can_invite_roles jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS invited_by integer REFERENCES admins(id) ON DELETE SET NULL;

-- Сід ролі (ідемпотентно; якщо власник уже правив роль — не чіпаємо).
INSERT INTO roles (key, label, is_system, pages, caps, notify, sort_order)
VALUES ('office_manager', 'Офіс-менеджер', false,
        '["/workers", "/legalization"]'::jsonb,
        '["viewWorkers", "workerDocs", "legalization", "workerPay"]'::jsonb,
        '[]'::jsonb, 50)
ON CONFLICT (key) DO NOTHING;
