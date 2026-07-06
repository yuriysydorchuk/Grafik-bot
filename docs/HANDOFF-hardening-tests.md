# HANDOFF: hardening + тести + бекапи + CI + скіл /deploy

Сесія 2026-07-05…06. Все задеплоєно на прод (коміти `2159943`, `b6d9c29`, `481199b`, `857804b`).
Довговічні факти вже перенесені в канонічні доки: міграції/CI/бекапи → `PROJECT_MAP.md`,
бекапи/міграції на проді → `docs/infrastructure/{DATABASE,PRODUCTION}.md`. Тут — контекст сесії.

## Що зроблено

**Надійність (за підсумками повного огляду проєкту):**
- `scheduleGenerator.ts` — генерація атомарна: план рахується в памʼяті, всі записи (wipe
  драфту + створення тижня + batch-INSERT) в одній транзакції. Матчинг legacy-рядків
  availability — через `matchWorker` (тільки confident), а не `includes`.
- `scheduler.ts` — дедуп пресмінних нагадувань дзеркалиться в `settings`
  (`preshift_sent_today`) і відновлюється після рестарту → `pm2 restart` посеред дня не шле
  повторні нагадування; дата дедуп-ключа через `warsawDateStr()` (не `toISOString`).
- `auth.ts` — прод без `SESSION_SECRET` не стартує (раніше тихо підписував сесії дефолтом).
- `admin-api.ts` — `nextWorkerCode` через `max()` у SQL; лічильники дашборда через `GROUP BY`
  (раніше вигрібали всі `schedule_entries`).
- **Індекси**: 9 шт. на гарячі таблиці (`deploy/migrations/2026-07-06-hot-table-indexes.sql`,
  на прод накатано, `CONCURRENTLY`).
- **Бекапи**: `deploy/backup.sh` + cron 03:00 на проді → `/root/backups/`, ротація 14 днів;
  перший бекап зроблено й перевірено (див. DATABASE.md).

**Тести (16 → 27):**
- `lib/payroll.test.ts` — umowa zlecenie: студент-пільга (обидва прапорці!), ZUS/health, краї.
- `services/mt940.test.ts` — парсер витягів: кодування utf8/cp1250/cp852, структуровані `^NN`
  і flat `/TXT/` (split payment) блоки `:86:`, derived closing без `:62F:`, reversal RD/RC,
  `matchCompanyName`.
- `bot/time.test.ts` (+) — `minutesUntilShift` (обгортка через північ), `pickupAssignmentSlot`
  (нічна зміна → день старту; понеділок → минулий тиждень), `factoryShiftHours` (нічні/дробові).

**Рефакторинг під тести (без зміни поведінки):**
- чистий MT940-шар винесено в `services/mt940.ts` (`bankStatements.ts` реекспортує — імпорти
  не зламані); причина: `bankStatements`/`scheduler` на рівні модуля тягнуть БД/бота, тестовий
  раннер без `DATABASE_URL`/токена їх імпортувати не може;
- `minutesUntilShift` + `pickupAssignmentSlot` переїхали в `bot/time.ts` (там лише type-імпорти).

**Інфраструктура процесу:**
- CI: `.github/workflows/ci.yml` (pnpm 11 / Node 26, typecheck + тести на push/PR).
- Скіл `/deploy`: `.claude/skills/deploy/SKILL.md` — ранбук деплою (перевірки → пуш → pull →
  міграції → `build.sh` → смоук healthz/логів + заборони).

## Перевірено

- typecheck чистий, 27/27 тестів, esbuild-збірка ок.
- Смоук генерації на dev-БД (тиждень 2027-01-04, потім зачищено): entries == totalAssigned,
  без дублів у межах дня, повторна генерація замінює драфт; бут сервера локально — healthz ok.
- Прод після деплою: `{"status":"ok","db":"ok","bot":"up"}`, у логах лише штатний startup-алерт.

## TODO / не зроблено (свідомо)

- **Інтеграційний тест генератора** (orders-режим + continuity + відсутності проти локальної БД,
  гейт по `TEST_DATABASE_URL`) — власник відклав «за окремою командою».
- Перший прогін CI на GitHub не перевірений (`gh` CLI недоступний локально) — глянути Actions.
- Offsite-копія бекапів + зовнішній uptime-монітор на `/api/healthz` — TODO власника.
- Гроші в схемі — `real` (float); `numeric` розглянути окремо (потребує міграції).
