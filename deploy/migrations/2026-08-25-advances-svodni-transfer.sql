-- Аванси → сводна: масове перенесення після звірки (дзеркало worker_badania.deducted).
-- svodni_month/svodni_applied_at = коли і в яку сводну перенесено суму (Zaliczka);
-- from-hours більше НЕ заповнює Zaliczka з виплачених авансів автоматично.

ALTER TABLE advance_requests
  ADD COLUMN IF NOT EXISTS svodni_month text,
  ADD COLUMN IF NOT EXISTS svodni_applied_at date;

-- Бекфіл: історичні виплачені аванси вже лягли у сводні через старий авто-механізм
-- from-hours (місяць = місяць дати виплати). Позначаємо перенесеними ті, для чиїх
-- працівників сводна того місяця реально існує — щоб масове перенесення їх не задвоїло.
UPDATE advance_requests a SET
  svodni_month = to_char(a.paid_at, 'YYYY-MM'),
  svodni_applied_at = a.paid_at::date
WHERE a.status = 'paid' AND a.paid_at IS NOT NULL AND a.svodni_month IS NULL
  AND EXISTS (SELECT 1 FROM svodni_rows s
              WHERE s.worker_id = a.worker_id
                AND s.period_month = to_char(a.paid_at, 'YYYY-MM')
                AND s.segment_of IS NULL);
