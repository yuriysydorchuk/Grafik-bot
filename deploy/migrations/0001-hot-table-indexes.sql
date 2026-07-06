-- 0001: індекси на гарячі таблиці (2026-07-06).
-- Схема живе в lib/db/src/schema/workers.ts; міграції накатуються вручну:
--   psql "$DATABASE_URL" -f deploy/migrations/0001-hot-table-indexes.sql
-- CONCURRENTLY не блокує запис, тому файл НЕ можна запускати в одній транзакції
-- (psql -1); кожна команда — окремо. IF NOT EXISTS робить повторний запуск безпечним.

-- schedule_entries — найбільша таблиця, скрізь фільтрується за week_id (+factory),
-- профіль працівника й фінанси йдуть від worker_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_schedule_entries_week ON schedule_entries (week_id, factory_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_schedule_entries_worker ON schedule_entries (worker_id);

-- Тижневі вибірки планування.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_availability_week ON availability (week_start);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_factory_orders_week ON factory_orders (week_start, factory_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_absence_requests_week ON absence_requests (week_start);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_driver_assignments_week ON driver_shift_assignments (week_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unplanned_workers_week ON unplanned_workers (week_id);

-- Поїздки/зміни водіїв — вибірки за датою.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_driver_trips_date ON driver_trips (trip_date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_driver_workdays_date ON driver_workdays (work_date);
