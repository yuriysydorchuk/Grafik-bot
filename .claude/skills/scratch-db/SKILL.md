---
name: scratch-db
description: Написати й запустити разовий scratch-скрипт проти БД Grafik-bot (аудит, порівняння, дебаг фінансових даних). Use when the user asks to перевірити/порівняти/порахувати щось у базі, розібрати сводну чи витяг, or when a one-off Node script against the DB is needed.
---

# Разові scratch-скрипти проти БД

Стандарт написання одноразових скриптів (аудити, звірки, дебаг). Мета — однаковий, безпечний, відтворюваний патерн замість варіацій.

## Де і як

- **Файл:** `artifacts/api-server/scratch-<тема>.mjs` (обов'язково в цій теці — інакше не резолвиться `@workspace/db`). Тема — kebab-case, коротко: `scratch-dbg-agram.mjs`, `scratch-cmp-june.mjs`.
- **Запуск:** з теки `artifacts/api-server`:
  ```bash
  node --env-file=../../.env scratch-<тема>.mjs
  ```
  Node ≥23: TS-імпорти з `./src/**/*.ts` працюють нативно (type stripping) — сервіси імпортуються прямо.
- **База:** `.env` у корені вказує на **локальну** `postgresql://localhost:5432/grafik_bot`. Перед запуском переконайся, куди дивиться `DATABASE_URL` (`grep -E "^DATABASE_URL" ../../.env | sed -E 's#//[^@]*@#//***@#'` — ніколи не друкуй пароль). Проти **проду** скрипти не ганяємо; прод-запити — тільки read-only `psql` через `ssh grafik` (SSH рейт-лімітиться — батчи команди).
- Перший рядок скрипта — коментар українською: що рахує і за який період.

## Шаблон

```js
// Що рахує цей скрипт і за який місяць/період.
import { db, pool, svodniRowsTable, workersTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
// сервіси бекенду — прямим TS-імпортом:
// import { parseLublinTab } from "./src/services/svodni.ts";
// import { matchWorker } from "./src/bot/workerMatch.ts";

const M = "2026-06"; // період завжди константою вгорі

// ... логіка ...

await pool.end(); // інакше процес висить
```

## Правила (жорсткі)

1. **Read-only за замовчуванням.** Скрипт лише читає і друкує. Будь-який UPDATE/INSERT/DELETE — тільки після явного «так» користувача на конкретний список змін ([[no-unsolicited-data-fixes]]: під час звірок фіксимо код, не дані). Мутаційний скрипт спершу запускається в **dry-run** (друкує, ЩО змінить) і має прапорець `APPLY=1` для реального запису.
2. **Дати — рядками.** Порівнюй `YYYY-MM-DD` як рядки; `new Date(...).toISOString()` зрізає день (прод у Europe/Berlin). Місяць — `entryDateStr.slice(0, 7)`.
3. **Не дублюй бізнес-логіку — імпортуй її.** Ставки/бонуси — `./src/services/svodni.ts` (`agramBonusPerHour`, `resolveBaseRates`), матчинг імен — `./src/bot/workerMatch.ts` (`matchWorker`), ключі/аліаси вкладок — `./src/services/payrollSummaries.ts` (`key`, `cleanName`, `TAB_ALIASES`), сегменти — `computeSegmented`. Свій `includes`-матч по імені чи власний розрахунок ставки в скретчі — регресія.
4. **Агрегати сводних** фільтруй `segment_of IS NULL` (сегменти — діти, батько = сума).
5. **Нормалізація рядків** (імена/вкладки): `.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").trim()`; числа з таблиць: кома → крапка, пробіли геть, `0`/NaN → `null`.
6. **Вивід** — компактні таблиці з підсумком і розбіжністю (`site vs book, diff`), округлення `Math.round(n*100)/100`. Звірка «до злотого»: diff ≤ 0.01 = збіг.
7. **Excel** читати/писати через `ExcelJS` (є в залежностях) або сирі grid-JSON (`readSourceGrids` з `./src/services/svodniFetch.ts` для Google-таблиць сводних).
8. Скрипти **не комітяться** як робочий код: цінний висновок переноситься в хендоф/док, а відпрацьовані `scratch-*.mjs` можна чистити пачкою після підтвердження користувача.
