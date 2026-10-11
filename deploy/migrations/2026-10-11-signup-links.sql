-- Персональні лінки реєстрації рекрутерів/офіс-менеджерів (11.10.2026): «хто привів».
-- Один сталий токен на пару адмін×фабрика (?start=rec<токен>); профіль, створений за ним,
-- отримує workers.signup_link_id (через passport_scan_tokens.signup_link_id у confirm()).
-- Ідемпотентно.
CREATE TABLE IF NOT EXISTS signup_links (
  id serial PRIMARY KEY,
  token text NOT NULL UNIQUE,
  admin_id integer NOT NULL REFERENCES admins(id),
  factory_id integer NOT NULL REFERENCES factories(id),
  created_at timestamp NOT NULL DEFAULT now(),
  rotated_at timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS signup_links_admin_factory_uq ON signup_links (admin_id, factory_id);

ALTER TABLE workers ADD COLUMN IF NOT EXISTS signup_link_id integer REFERENCES signup_links(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS workers_signup_link_idx ON workers (signup_link_id) WHERE signup_link_id IS NOT NULL;
ALTER TABLE passport_scan_tokens ADD COLUMN IF NOT EXISTS signup_link_id integer REFERENCES signup_links(id) ON DELETE SET NULL;

-- Право `signupLinks` + сторінка /signup-links: офіс-менеджеру і ролям з рекрутингом (мають /recruitment).
-- owner права має завжди (у коді), рядок ролі не чіпаємо.
UPDATE roles SET caps = caps || '["signupLinks"]'::jsonb
  WHERE key <> 'owner' AND NOT caps ? 'signupLinks' AND NOT caps ? 'readOnly'
    AND (key = 'office_manager' OR pages ? '/recruitment');
UPDATE roles SET pages = pages || '["/signup-links"]'::jsonb
  WHERE key <> 'owner' AND NOT pages ? '/signup-links' AND caps ? 'signupLinks';
