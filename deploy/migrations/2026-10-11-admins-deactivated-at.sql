-- 11.10.2026: деактивація адміна замість жорсткого видалення (DELETE падав на FK історії:
-- worker_changes, tasks, worker_documents, contracts… ~30 таблиць). Деактивований — без входу
-- й бота, поза списками/пікерами; імʼя в журналах лишається. Повернення — POST /admins/:id/reactivate.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS deactivated_at timestamp;
