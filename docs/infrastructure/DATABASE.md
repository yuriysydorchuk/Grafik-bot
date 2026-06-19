# DATABASE — база даних

> Стан БД на проді — [PRODUCTION.md](PRODUCTION.md). Деталі пакета схеми — [`lib/db/README.md`](../../lib/db/README.md).

---

## Підключення

| | |
|---|---|
| СУБД | PostgreSQL 16 |
| База | `grafik_bot` |
| Юзер | `grafik` |
| Хост | `localhost:5432` (назовні **не** відкрита) |
| Рядок підключення | env-змінна `DATABASE_URL` (значення — у `/root/grafik-bot/.env`, **не тут**) |

Підключитись на сервері:
```bash
psql "$(grep ^DATABASE_URL= /root/grafik-bot/.env | cut -d= -f2-)"
```

---

## Схема — джерело правди

- **Єдине джерело правди — Drizzle-схема:** [`lib/db/src/schema/workers.ts`](../../lib/db/src/schema/workers.ts)
  (усі таблиці + типи). Клієнт БД: `lib/db/src/index.ts`.
- **Bootstrap-дамп:** [`deploy/schema.sql`](../../deploy/schema.sql) — використовується при розгортанні з нуля.
  Перегенеровано 2026-06-19 з живої БД (усі **26 таблиць**, PG16-сумісний). Раніше був неповний —
  тепер актуальний. **Перегенеровувати після кожної зміни схеми** (нижче), інакше чистий деплой буде неповним.

Перегенерувати дамп (з машини з актуальною БД):
```bash
pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges --no-comments > deploy/schema.sql
# Прибрати PG17-only рядки, якщо цільовий сервер на PG16:
#   видалити рядок "SET transaction_timeout = 0;"
```

---

## Як застосовуються зміни схеми

**Міграцій-файлів немає.** `drizzle-kit push` ненадійний у non-TTY. Зміни накатуються **вручну
через `psql`**, ідемпотентними SQL-командами, синхронно зі схемою в коді:

```bash
psql "$DATABASE_URL" -c "ALTER TABLE <t> ADD COLUMN IF NOT EXISTS <col> <type>;"
```

Порядок:
1. Зміни `lib/db/src/schema/workers.ts`.
2. Накати відповідний `ALTER`/`CREATE` через `psql` на сервері.
3. `pnpm run typecheck:libs` (перебудувати декларації) → деплой коду.

Приклад реальної міграції (фіча «документи»):
```sql
ALTER TABLE worker_documents
  ADD COLUMN IF NOT EXISTS file_path text,
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS file_mime text;
```

---

## Backup / restore

**Backup (дамп БД):**
```bash
pg_dump "$DATABASE_URL" | gzip > ~/backup-grafik-$(date +%F).sql.gz
```
**Backup завантажених файлів** (поза БД!):
```bash
tar czf ~/backup-uploads-$(date +%F).tar.gz -C /root/grafik-bot uploads
```
**Restore:**
```bash
gunzip -c ~/backup-grafik-YYYY-MM-DD.sql.gz | psql "$DATABASE_URL"
tar xzf ~/backup-uploads-YYYY-MM-DD.tar.gz -C /root/grafik-bot
```
Приклади cron — у [`deploy/DEPLOY.md`](../../deploy/DEPLOY.md) (розділи «Бекап бази» / «Завантажені файли»).

> ⚠️ **Стан на 2026-06-19: app-бекап НЕ налаштований** — `crontab -l` порожній, дампів у `/root` немає.
> На рівні провайдера, ймовірно, увімкнено **Contabo Auto Backup** (снапшоти VM, обиралось при
> купівлі) — це інше й app-дані не гарантує. **TODO:** додати cron `pg_dump` + `tar uploads/`
> (приклади — [`deploy/DEPLOY.md`](../../deploy/DEPLOY.md)); **TODO:** offsite-зберігання дампів
> (поки лежали б на тому ж сервері); **TODO:** підтвердити статус Contabo Auto Backup у панелі.

---

## Важливі таблиці (огляд)

Повний перелік полів — у схемі. Групи:

- **Довідники:** `companies`, `factories`, `positions`, `factory_positions`, `workers`, `drivers`, `admins`
- **Планування:** `factory_orders`, `availability`, `schedule_weeks`, `schedule_entries`,
  `schedule_approvals`, `driver_shift_assignments`
- **Операції:** `driver_trips`, `unplanned_workers`, `absence_requests`, `hours_disputes`
- **Рекрутинг:** `funnels`, `candidates`, `candidate_activity`
- **Документи:** `document_types`, `worker_documents` (файли на диску — у `uploads/`, у БД лише метадані)
- **Сервісні:** `notifications`, `user_states` (стан діалогів бота), `bot_messages`, `settings`

Особливо чутливі:
- `admins` — облікові записи адмінів, **хеші паролів** веб-панелі (`web_*`), `is_main`. Не дампити вміст у логи/чат.
- `settings` — зокрема ключі Google Drive (ID файлів/папок).

---

## Правила безпеки

- БД слухає **лише localhost** — не відкривати порт 5432 назовні.
- `DATABASE_URL` живе тільки в `.env` (не в git, не в доках).
- **Не виконувати `SELECT *` з `admins`** з виводом у логи/чат (хеші паролів). Для діагностики —
  лише `count(*)` / булеві ознаки наявності.
- Перед руйнівними SQL (DROP/TRUNCATE/масовий UPDATE) — спершу `pg_dump`.
- `seed-test.sql` у репо робить `TRUNCATE` — **ніколи не запускати на проді**.
- Головного адміна (`admins.is_main`) призначає лише він сам; через бота видати `is_main` не можна.
