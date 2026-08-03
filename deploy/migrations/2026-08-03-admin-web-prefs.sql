-- Персональні UI-налаштування веб-панелі (порядок вкладок міст/фабрик тощо).
-- Ключ-значення jsonb на акаунт; пишеться через POST /auth/web-prefs.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS web_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Дані: фабрики без фірми (підтверджено власником 03.08.2026) — кольори вкладок
-- в Обліку годин/Сводних беруться з factories.company_id. MAKARUK і JUKKI
-- неактивні, але фірма потрібна для кольору в історичних місяцях.
UPDATE factories SET company_id = (SELECT id FROM companies WHERE name = 'ES')
WHERE name IN ('EUROCASH KROSNO', 'RECYKLING', 'MAKARUK', 'JUKKI') AND company_id IS NULL;
