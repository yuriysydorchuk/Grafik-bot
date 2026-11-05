-- Правило задач fire_review («Звільнення з обліку годин — перевірити дату», services/fireReview.ts):
-- запасний виконавець, коли у фабрики немає ні графікового, ні відповідального, — той самий, що вже
-- стоїть у правилі «документ звільнення» (termination_doc). Рішення власника 05.11.2026: на проді
-- графіковий заповнений лише у 2 фабрик, без цього задачі йшли б головному адміну.
-- Ідемпотентно: рядок створюється, якщо його ще немає; уже виставленого виконавця не чіпає.
INSERT INTO task_auto_rules (code, enabled, lead_days, params, fallback_admin_id)
SELECT 'fire_review', true, NULL, '{}'::jsonb, (SELECT fallback_admin_id FROM task_auto_rules WHERE code = 'termination_doc')
ON CONFLICT (code) DO UPDATE SET fallback_admin_id = COALESCE(task_auto_rules.fallback_admin_id, EXCLUDED.fallback_admin_id);
