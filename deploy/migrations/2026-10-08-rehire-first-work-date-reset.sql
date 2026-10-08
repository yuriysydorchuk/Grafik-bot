-- Повернені на роботу після звільнення (журнал worker_changes.restored) зберігали first_work_date
-- від ПЕРШОГО найму → строк powiadomienie UA рахувався від старої дати, задача одразу «прострочена».
-- Обнуляємо дату лише там, де повернення сталося ПІСЛЯ неї; нічний бекфіл (backfillFirstWorkDates)
-- і відкриття профілю перерахують її з явок після повернення (services/firstWorkDate.ts).
-- Ідемпотентно: повторний прогін нічого не змінює.
UPDATE workers w
SET first_work_date = NULL
WHERE w.is_active
  AND w.first_work_date IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM worker_changes c
    WHERE c.worker_id = w.id AND c.field = 'restored' AND c.effective_date > w.first_work_date
  );
