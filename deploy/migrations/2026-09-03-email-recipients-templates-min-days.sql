-- 2026-09-03: кілька email-отримувачів графіку на фабрику + глобальні email-шаблони;
-- мінімум днів доступності на тиждень (правило фабрики).
-- Ідемпотентно. Старий factories.client_email лишається як кеш «усі адреси через кому».

CREATE TABLE IF NOT EXISTS email_templates (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS factory_email_recipients (
  id          SERIAL PRIMARY KEY,
  factory_id  INTEGER NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  name        TEXT,
  template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS factory_email_recipients_uq ON factory_email_recipients (factory_id, email);

-- Перенос наявних адрес: одна адреса → один отримувач зі стандартним шаблоном.
INSERT INTO factory_email_recipients (factory_id, email)
SELECT f.id, lower(trim(f.client_email))
FROM factories f
WHERE f.client_email IS NOT NULL AND trim(f.client_email) <> ''
  AND NOT EXISTS (SELECT 1 FROM factory_email_recipients r WHERE r.factory_id = f.id)
ON CONFLICT DO NOTHING;

-- Стандартний шаблон створюється кодом при першому зверненні (ensureDefaultTemplate)
-- зі старих значень settings.email_tpl_schedule_subject/body.

ALTER TABLE factories ADD COLUMN IF NOT EXISTS min_days_per_week INTEGER;
