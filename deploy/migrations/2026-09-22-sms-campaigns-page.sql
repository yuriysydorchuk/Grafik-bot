-- Сторінка /sms-campaigns у ролі графікової (owner має повний доступ у коді). Ідемпотентно.
UPDATE roles SET pages = pages || '["/sms-campaigns"]'::jsonb WHERE key = 'scheduler' AND NOT (pages ? '/sms-campaigns');
