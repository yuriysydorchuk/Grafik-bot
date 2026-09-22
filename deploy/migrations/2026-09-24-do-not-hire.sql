-- Чорний список працівників (рішення власника 21.09.2026): прапорець «не наймати» з причиною.
-- Окрема вкладка в списку працівників; відновлення/кандидат з таким же імʼям — лише з підтвердженням.
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS do_not_hire boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS do_not_hire_reason text,
  ADD COLUMN IF NOT EXISTS do_not_hire_at timestamp,
  ADD COLUMN IF NOT EXISTS do_not_hire_by integer REFERENCES admins(id);
