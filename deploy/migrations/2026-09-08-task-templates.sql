-- Модуль «Задачі»: стартові шаблони з макета (Онбординг / Звільнення / Закриття сводної / Нова фабрика).
-- Ідемпотентно: сідимо лише якщо шаблону з такою назвою ще немає. Тригери worker_created /
-- worker_fired спрацьовують у services/tasks.ts (applyTemplateTriggers) при створенні/звільненні.
INSERT INTO task_templates (name, kind, title_template, description, checklist, review_required, due_in_days, trigger, is_active)
SELECT 'Онбординг нового працівника', 'task', 'Онбординг: {worker}', 'Запускається сам при реєстрації працівника.',
  '["Перевірити анкету і скан паспорта","Внести підстави перебування і праці","Згенерувати умову й надіслати на підпис","Подати powiadomienie / oświadczenie (якщо потрібно)","Записати на badania і sanepid","Видати спецодяг і записати в «Одяг»","Додати до графіку й повідомити водія"]'::jsonb,
  false, 7, 'worker_created', true
WHERE NOT EXISTS (SELECT 1 FROM task_templates WHERE name = 'Онбординг нового працівника');

INSERT INTO task_templates (name, kind, title_template, description, checklist, review_required, due_in_days, trigger, is_active)
SELECT 'Звільнення працівника', 'task', 'Звільнення: {worker}', 'Запускається сам при звільненні.',
  '["Закрити умову / зняти з ZUS","Розрахувати залишок годин і авансів","Забрати спецодяг і перепустку","Закрити хостел, якщо жив","Повідомити фабрику й водія"]'::jsonb,
  true, 5, 'worker_fired', true
WHERE NOT EXISTS (SELECT 1 FROM task_templates WHERE name = 'Звільнення працівника');

INSERT INTO task_templates (name, kind, title_template, description, checklist, review_required, due_in_days, recurrence, trigger, is_active)
SELECT 'Закриття сводної міста', 'task', 'Закрити сводну за місяць', 'Повторюється щомісяця 5-го числа.',
  '["Звірити години з рапортами фабрик","Перевірити аванси й бадання","Перевірити статуси для виплат (зміни за документами)","Сформувати сводну і залочити","Експорт у Gratyfikant","Надіслати księgowej"]'::jsonb,
  true, 5, '{"freq":"monthly","monthday":5}'::jsonb, 'manual', true
WHERE NOT EXISTS (SELECT 1 FROM task_templates WHERE name = 'Закриття сводної міста');

INSERT INTO task_templates (name, kind, title_template, description, checklist, review_required, due_in_days, trigger, is_active)
SELECT 'Нова фабрика', 'task', 'Запуск фабрики: {worker}', 'Ставиться вручну при новому клієнті.',
  '["Внести фабрику, зміни, посади і ставки","Призначити відповідального і графікову","Налаштувати шаблон умови й czynności по посадах","Додати email-отримувачів графіку"]'::jsonb,
  false, 14, 'manual', true
WHERE NOT EXISTS (SELECT 1 FROM task_templates WHERE name = 'Нова фабрика');
