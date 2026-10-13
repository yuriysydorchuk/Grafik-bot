-- Залічки за бадання і одяг частинами (13.10.2026): при додаванні можна зняти
-- зразу (як було), розбити на 2–3 місяці або на N частин вручну. Кожна частина —
-- окремий рядок зі своїм місяцем «з якого знімати» (due_month, YYYY-MM):
-- перенесення у сводну місяця M бере лише рядки з due_month IS NULL або <= M.
-- NULL = «зразу» (поведінка до фічі, наявні рядки не чіпаємо).
ALTER TABLE worker_badania
  ADD COLUMN IF NOT EXISTS due_month   text,
  ADD COLUMN IF NOT EXISTS part_no     integer,
  ADD COLUMN IF NOT EXISTS parts_total integer,
  ADD COLUMN IF NOT EXISTS part_group  integer; -- id першої частини (спільний для всіх частин однієї залічки)

ALTER TABLE clothing_items
  ADD COLUMN IF NOT EXISTS due_month   text,
  ADD COLUMN IF NOT EXISTS part_no     integer,
  ADD COLUMN IF NOT EXISTS parts_total integer,
  ADD COLUMN IF NOT EXISTS part_of     integer REFERENCES clothing_items(id) ON DELETE CASCADE; -- частини 2..N фізичної речі (part_of = запис видачі зі складом)

CREATE INDEX IF NOT EXISTS clothing_items_part_of_idx ON clothing_items(part_of);
