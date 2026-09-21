-- SMS-кампанії (батч 4): тип бот-сповіщень `sms` (денний звіт хвилі, завершення кампанії) —
-- увімкнути ролям, що мають сторінку /sms-campaigns, і власнику. Ідемпотентно.
UPDATE roles SET notify = notify || '["sms"]'::jsonb WHERE NOT (notify ? 'sms') AND (key = 'owner' OR pages ? '/sms-campaigns');
-- правило автозадач sms_no_bot сідиться кодом (ensureAutoRules) при нічному прогоні
