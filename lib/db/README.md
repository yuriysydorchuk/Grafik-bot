# @workspace/db

Пакет схеми бази даних для **Grafik-bot** — **єдине джерело правди** про структуру PostgreSQL (Drizzle ORM). Споживається і бекендом, і (через типи) рештою системи. Огляд системи — у [`/CLAUDE.md`](../../CLAUDE.md).

## Що всередині

```
src/
├── index.ts            ініціалізація drizzle-клієнта (експорт `db`) + ре-експорт схеми
└── schema/
    ├── index.ts        ре-експорт усіх таблиць/типів
    └── workers.ts      ВСЯ схема: таблиці, enum-и, Drizzle-типи, zod insert-схеми
```

Експорти пакета (`package.json`): `@workspace/db` → `src/index.ts` (клієнт `db` + таблиці), `@workspace/db/schema` → `src/schema/index.ts`.

## Як споживається

```ts
import { db, workersTable, type Worker } from "@workspace/db";
const rows = await db.select().from(workersTable);
```

Підключення — через `DATABASE_URL`. Таблиці й типи (`$inferSelect`) використовуються в `api-server` (роути, сервіси, бот). Типи зі схеми — основа типобезпеки по всьому бекенду.

## Основні таблиці (огляд)

- **Персонал/довідники:** `companies` (наші фірми), `factories` (фабрики клієнтів: режим генерації, зміни, прапорці посад/статі, ставка рахунку), `positions` (каталог посад) + `factory_positions` (посади на фабриці зі ставками: оплата + рахунок клієнту), `workers` (працівники: посада, стать, закріплена зміна, ставка), `drivers` (водії), `admins` (адміни веб-панелі + ролі, `is_main`).
- **Планування:** `factory_orders` (замовлення на день/зміну + розбивка по посадах/статі), `availability` (доступність із Sheets/Telegram), `schedule_weeks` (тижні: чернетка/затверджено), `schedule_entries` (призначення працівник×фабрика×день×зміна×статус), `schedule_approvals` (затвердження по фабриці), `driver_shift_assignments` (водій на зміну).
- **Операції:** `driver_trips` (поїздки: старт/прибуття, спізнення), `unplanned_workers` (додані водієм на місці), `absence_requests` (зголошені відсутності + заміни), `hours_disputes` (спірні години).
- **Рекрутинг:** `funnels` (воронки) + `candidates` (кандидати) + `candidate_activity` (історія дій CRM).
- **Документи:** `document_types` (каталог обовʼязкових документів) + `worker_documents` (документи працівника).
- **Сервісні:** `notifications` (центр сповіщень веб), `user_states` (стан діалогів бота — переживає рестарт), `bot_messages` (трекінг для очищення чатів), `settings` (ключ-значення: Drive folder IDs тощо).

> Точні поля та звʼязки — у `src/schema/workers.ts`. Це найкраще джерело правди; цей перелік лише орієнтовний.

## Зміни схеми — вручну через psql

`drizzle-kit push` ненадійний у non-TTY (а тут schema-first без міграційних файлів), тож зміни накатуються **SQL-командами** напряму:

```bash
psql "$DATABASE_URL" -c "ALTER TABLE workers ADD COLUMN IF NOT EXISTS gender text;"
```

Робочий цикл при зміні структури:

1. відредагуй `src/schema/workers.ts` (таблиця/колонка/тип);
2. накати відповідний SQL у БД через `psql` (тримай SQL і схему синхронними; використовуй `IF NOT EXISTS` для ідемпотентності);
3. `pnpm run typecheck:libs` — перебудувати декларації lib;
4. `pnpm run typecheck` — переконатися, що artifacts бачать нові типи.

Скрипти пакета `push` / `push-force` (drizzle-kit) лишені для довідки, але **не основний шлях**. Початкова схема для нового середовища — у [`deploy/schema.sql`](../../deploy/schema.sql).
