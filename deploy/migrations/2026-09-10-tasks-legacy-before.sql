-- Дата запуску модуля задач/легалізації (рішення власника 10.09.2026): працівники,
-- додані до 08.09.2026 без жодного документа й умови, движкових автозадач не отримують
-- (services/taskLegacy.ts). Ідемпотентно: ставимо лише якщо параметра ще нема.
INSERT INTO task_auto_rules (code, enabled, params)
VALUES ('settings', true, '{"legacyBefore":"2026-09-08"}'::jsonb)
ON CONFLICT (code) DO UPDATE
  SET params = task_auto_rules.params || '{"legacyBefore":"2026-09-08"}'::jsonb, updated_at = now()
  WHERE NOT (task_auto_rules.params ? 'legacyBefore');
