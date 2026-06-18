-- Test seed for Grafik-bot. Preserves admins. Run with: psql "$DATABASE_URL" -f seed-test.sql
-- Anchored to the week of 2026-06-08 (current), with May history + a future week.
BEGIN;

TRUNCATE schedule_entries, schedule_approvals, driver_shift_assignments, driver_trips,
         unplanned_workers, absence_requests, availability, factory_orders,
         schedule_weeks, candidates, hours_disputes, bot_messages, workers, drivers, factories
  RESTART IDENTITY CASCADE;
DELETE FROM settings WHERE key LIKE 'schedule_file_%' OR key LIKE 'drive_%';

-- ── Factories: varied configs + pickup stops ───────────────────────────────
INSERT INTO factories (name, address, shift1_start, shift2_start, shift3_start, shift_count, uses_availability, client_email, shifts, stops) VALUES
  ('LST',        'вул. Промислова 1', '06:00', '14:00', '22:00', 3, true,  'client-lst@example.com',
     '[{"start":"06:00","end":"14:00"},{"start":"14:00","end":"22:00"},{"start":"22:00","end":"06:00"}]'::jsonb,
     '[{"name":"Ринок, головний вхід","time":"05:20"},{"name":"Автовокзал","time":"05:35"},{"name":"ТЦ Депо","time":"05:45"}]'::jsonb),
  ('Karton-Pak', 'вул. Заводська 5',  '07:00', '19:00', NULL,    2, true,  NULL,
     '[{"start":"07:00","end":"19:00"},{"start":"19:00","end":"07:00"}]'::jsonb,
     '[{"name":"Площа Ринок","time":"06:20"},{"name":"Залізничний вокзал","time":"06:35"}]'::jsonb),
  ('Mlekovita',  'вул. Молочна 12',   '08:00', '20:00', NULL,    2, false, 'client-mlek@example.com',
     '[{"start":"08:00","end":"20:00"},{"start":"20:00","end":"08:00"}]'::jsonb,
     '[]'::jsonb);

-- ── Workers: 24 generic (codes 10001..10024, 8 per factory) ────────────────
INSERT INTO workers (full_name, worker_code, factory_id, status, is_active)
SELECT n.name, (10000 + n.ord)::text, ((n.ord - 1) / 8) + 1, 'active', true
FROM unnest(ARRAY[
  'Олександр Іваненко','Михайло Бондаренко','Андрій Ткаченко','Сергій Кравченко','Дмитро Олійник','Василь Мороз','Іван Кравець','Юрій Поліщук',
  'Олег Мельник','Назар Гончар','Тарас Савченко','Роман Бойко','Віктор Шевченко','Богдан Лисенко','Максим Руденко','Артем Захарчук',
  'Павло Марченко','Денис Костенко','Володимир Панчук','Євген Данилюк','Ростислав Левчук','Степан Гаврилюк','Анатолій Дмитренко','Григорій Власенко'
]) WITH ORDINALITY AS n(name, ord);

-- ── Real Telegram-linked workers (so bot testing keeps working) ────────────
INSERT INTO workers (full_name, worker_code, factory_id, telegram_id, status, is_active) VALUES
  ('Тетіана Сидорчук', '10025', 1, '5019696650', 'active', true),  -- id 25, LST
  ('Anton Zaiets',     '10026', 2, '389301803',  'active', true);  -- id 26, Karton-Pak

-- one fired worker (to test the "Звільнені" filter)
INSERT INTO workers (full_name, worker_code, factory_id, status, is_active, fired_at)
  VALUES ('Колишній Працівник', '10027', 3, 'fired', false, now());  -- id 27

-- ── Drivers (Roman has a real Telegram + username for link testing) ────────
INSERT INTO drivers (name, phone, vehicle, invite_code, username, telegram_id, is_head_driver, is_active) VALUES
  ('Богдан Шевчук',    '+380501112233', 'Mercedes Sprinter', 'drv001', NULL,            NULL,        true,  true),  -- id 1 head
  ('Ігор Коваль',      '+380502223344', 'VW Crafter',        'drv002', NULL,            NULL,        false, true),  -- id 2
  ('Петро Сидоренко',  '+380503334455', 'Ford Transit',      'drv003', NULL,            NULL,        false, true),  -- id 3
  ('Roman Vin Disel',  '+380504445566', 'Renault Master',    'drv004', 'RomanSydorchuk','331674574', false, true);  -- id 4

-- ══ WEEKS: current + next + 4 May/June history (all approved) ══════════════
INSERT INTO schedule_weeks (week_start, status, approved_at) VALUES
  ('2026-06-08','approved', now()),        -- id 1 CURRENT (today is Fri 2026-06-12)
  ('2026-06-15','approved', now()),        -- id 2 NEXT (future → scheduled)
  ('2026-05-11','approved','2026-05-11'),  -- id 3
  ('2026-05-18','approved','2026-05-18'),  -- id 4
  ('2026-05-25','approved','2026-05-25'),  -- id 5
  ('2026-06-01','approved','2026-06-01');  -- id 6

-- worked weeks (current + history): mon–fri, ~11% absences (half with a reason)
INSERT INTO schedule_entries (week_id, worker_id, factory_id, day_of_week, shift, status, absence_reason)
SELECT wk.wid, w.id, w.factory_id, d.day::day_of_week,
  (CASE WHEN w.factory_id = 1
        THEN (CASE WHEN ((w.id-1)%8)+1 <= 3 THEN '1' WHEN ((w.id-1)%8)+1 <= 6 THEN '2' ELSE '3' END)
        ELSE (CASE WHEN ((w.id-1)%8)+1 <= 4 THEN '1' ELSE '2' END) END)::shift,
  (CASE WHEN ((w.id*3 + wk.wid*5 + d.idx) % 9) = 0 THEN 'absent' ELSE 'present' END)::entry_status,
  (CASE WHEN ((w.id*3 + wk.wid*5 + d.idx) % 9) = 0 AND (w.id % 2 = 0) THEN 'Відпросився' ELSE NULL END)
FROM workers w
CROSS JOIN (VALUES (1),(3),(4),(5),(6)) AS wk(wid)
CROSS JOIN (VALUES ('mon',0),('tue',1),('wed',2),('thu',3),('fri',4)) AS d(day, idx)
WHERE w.is_active;

-- future week (id 2): mon–fri, all "scheduled"
INSERT INTO schedule_entries (week_id, worker_id, factory_id, day_of_week, shift, status)
SELECT 2, w.id, w.factory_id, d.day::day_of_week,
  (CASE WHEN w.factory_id = 1
        THEN (CASE WHEN ((w.id-1)%8)+1 <= 3 THEN '1' WHEN ((w.id-1)%8)+1 <= 6 THEN '2' ELSE '3' END)
        ELSE (CASE WHEN ((w.id-1)%8)+1 <= 4 THEN '1' ELSE '2' END) END)::shift,
  'scheduled'
FROM workers w
CROSS JOIN (VALUES ('mon'),('tue'),('wed'),('thu'),('fri')) AS d(day)
WHERE w.is_active;

-- a few manual hours overrides (demonstrate edited hours) on June history week
UPDATE schedule_entries SET hours_override = 10
 WHERE id IN (SELECT id FROM schedule_entries WHERE week_id = 6 AND status = 'present' ORDER BY id LIMIT 3);

-- per-factory approvals for every week
INSERT INTO schedule_approvals (week_id, factory_id)
SELECT wk.wid, f.id FROM (VALUES (1),(2),(3),(4),(5),(6)) wk(wid) CROSS JOIN (VALUES (1),(2),(3)) f(id);

-- driver assignments for the current week (id 1) and next week (id 2)
INSERT INTO driver_shift_assignments (week_id, factory_id, day_of_week, shift, driver_id)
SELECT x.wk, x.f, d.day::day_of_week, x.s::shift, x.drv
FROM (VALUES (1,1,'1',1),(1,1,'2',2),(1,2,'1',4),(1,3,'1',3),
             (2,1,'1',1),(2,2,'1',4),(2,3,'1',3)) AS x(wk,f,s,drv)
CROSS JOIN (VALUES ('mon'),('tue'),('wed'),('thu'),('fri')) AS d(day);

-- driver trips for today (Fri 2026-06-12) — for live/trips, incl. one late pickup
INSERT INTO driver_trips (driver_id, week_id, factory_id, day_of_week, shift, trip_date, pickup_started_at, arrived_factory_at, late_to_pickup, late_to_factory) VALUES
  (1, 1, 1, 'fri', '1', '2026-06-12', '2026-06-12 04:30', '2026-06-12 05:45', false, false),
  (4, 1, 2, 'fri', '1', '2026-06-12', '2026-06-12 05:40', '2026-06-12 06:55', true,  false),
  (3, 1, 3, 'fri', '1', '2026-06-12', '2026-06-12 06:10', NULL,               false, false);

-- a couple unplanned (driver-added) workers today
INSERT INTO unplanned_workers (week_id, driver_id, factory_id, day_of_week, shift, worker_name) VALUES
  (1, 1, 1, 'fri', '1', 'Невідомий Пасажир'),
  (1, 4, 2, 'fri', '1', 'Додатковий Робітник');

-- ── Next-week orders (for "Generate schedule" testing) ─────────────────────
INSERT INTO factory_orders (factory_id, week_start, day_of_week, shift, workers_needed)
SELECT x.f, '2026-06-15'::date, d.day::day_of_week, x.s::shift, x.n
FROM (VALUES (1,'1',3),(1,'2',3),(1,'3',2),(2,'1',4),(2,'2',2),(3,'1',3),(3,'2',2)) AS x(f,s,n)
CROSS JOIN (VALUES ('mon'),('tue'),('wed'),('thu'),('fri')) AS d(day);

-- ── Next-week availability (auto factories only; ~75% filled) ──────────────
INSERT INTO availability (full_name_raw, worker_id, source, week_start, day_of_week, shift, submitted_at)
SELECT w.full_name, w.id, 'telegram', '2026-06-15'::date, d.day::day_of_week,
  (CASE WHEN w.factory_id=1 THEN (CASE WHEN ((w.id-1)%8)+1<=3 THEN '1' WHEN ((w.id-1)%8)+1<=6 THEN '2' ELSE '3' END)
        ELSE (CASE WHEN ((w.id-1)%8)+1<=4 THEN '1' ELSE '2' END) END)::shift,
  now()
FROM workers w
CROSS JOIN (VALUES ('mon'),('tue'),('wed'),('thu'),('fri')) AS d(day)
WHERE w.is_active AND w.factory_id IN (1,2) AND (w.id % 4) <> 0;

-- ── Absence requests (worker self-reported) for next week ──────────────────
INSERT INTO absence_requests (worker_id, week_start, day_of_week, shift, reason, status) VALUES
  (5,  '2026-06-15', 'wed', '2', 'Сімейні обставини', 'pending'),
  (12, '2026-06-15', 'thu', '1', 'Лікар',             'pending'),
  (25, '2026-06-15', 'fri', '1', 'Відпустка за свій', 'accepted');

-- ══ REFERRALS: candidates at various stages ════════════════════════════════
INSERT INTO candidates (referrer_worker_id, full_name, telegram_id, phone, factory_id, stage, worker_id, bonus_amount, bonus_paid, notes) VALUES
  (1,  'Назар Петренко',  NULL, '+380631112201', 1, 'new',       NULL, NULL, false, NULL),
  (1,  'Олена Гриценко',  NULL, '+380631112202', 1, 'contacted', NULL, NULL, false, 'Передзвонити завтра'),
  (3,  'Ірина Мельник',   NULL, '+380631112203', 2, 'interview', NULL, NULL, false, 'Призначено співбесіду на пн'),
  (25, 'Сергій Бойчук',   NULL, '+380631112204', 1, 'hired',     1,    200,  true,  'Вийшов, бонус сплачено'),
  (5,  'Андрій Лис',      NULL, '+380631112205', 2, 'rejected',  NULL, NULL, false, 'Не підійшов графік'),
  (25, 'Марія Іваненко',  NULL, '+380631112206', 1, 'hired',     2,    NULL, false, 'Працює, бонус ще не сплачено');

-- ══ HOURS DISPUTES (structured worker corrections) ═════════════════════════
-- Tetiana: remove one present shift + add a missing one
INSERT INTO hours_disputes (worker_id, month, items, status)
SELECT w.id, '2026-06',
  jsonb_build_array(
    jsonb_build_object('kind','remove',
      'entryId',(SELECT e.id FROM schedule_entries e WHERE e.worker_id=w.id AND e.status='present' AND e.week_id=1 ORDER BY e.id LIMIT 1),
      'date','2026-06-09','shift','1','factoryName','LST'),
    jsonb_build_object('kind','add','date','2026-06-10','shift','1','factoryId',w.factory_id,'factoryName','LST')
  ), 'new'
FROM workers w WHERE w.telegram_id = '5019696650';

-- Anton: a "wrong hours" flag with a comment
INSERT INTO hours_disputes (worker_id, month, items, message, status)
SELECT w.id, '2026-06',
  jsonb_build_array(jsonb_build_object('kind','wrong',
    'entryId',(SELECT e.id FROM schedule_entries e WHERE e.worker_id=w.id AND e.status='present' AND e.week_id=1 ORDER BY e.id LIMIT 1),
    'date','2026-06-08','shift','1','factoryName','Karton-Pak')),
  'Мало бути 12 годин, а порахувало менше', 'new'
FROM workers w WHERE w.telegram_id = '389301803';

COMMIT;

-- summary
SELECT 'factories' t, count(*) c FROM factories
UNION ALL SELECT 'workers (active)', count(*) FROM workers WHERE is_active
UNION ALL SELECT 'workers w/ telegram', count(*) FROM workers WHERE telegram_id IS NOT NULL
UNION ALL SELECT 'drivers', count(*) FROM drivers
UNION ALL SELECT 'weeks', count(*) FROM schedule_weeks
UNION ALL SELECT 'entries (all)', count(*) FROM schedule_entries
UNION ALL SELECT 'entries present', count(*) FROM schedule_entries WHERE status='present'
UNION ALL SELECT 'entries absent', count(*) FROM schedule_entries WHERE status='absent'
UNION ALL SELECT 'hours overrides', count(*) FROM schedule_entries WHERE hours_override IS NOT NULL
UNION ALL SELECT 'driver assignments', count(*) FROM driver_shift_assignments
UNION ALL SELECT 'driver trips', count(*) FROM driver_trips
UNION ALL SELECT 'candidates', count(*) FROM candidates
UNION ALL SELECT 'hours disputes', count(*) FROM hours_disputes
UNION ALL SELECT 'next-week orders', count(*) FROM factory_orders
UNION ALL SELECT 'next-week availability', count(*) FROM availability
ORDER BY t;
