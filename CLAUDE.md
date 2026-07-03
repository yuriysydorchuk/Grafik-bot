# CLAUDE.md

Орієнтир для роботи з кодовою базою. Описує систему, архітектуру, команди та правила розробки.

> **Legacy:** файл `replit.md` у корені — застарілий опис ранньої версії (ще до веб-панелі, рекрутингу, посад тощо). Тримаємо для історії, але **актуальне джерело — цей файл**.

---

## Опис системи

**Grafik-bot** — система планування персоналу для кадрової агенції (бренд **Euro Support**), яка постачає працівників на фабрики клієнтів. Складається з:

- **Telegram-бота** для трьох аудиторій: працівники, водії, офіс/адміністрація (багатомовний);
- **веб-панелі адміністратора** (двомовна: укр/англ);
- **REST API** + **PostgreSQL**.

Можливості: щотижневі графіки змін, замовлення фабрик (з розбивкою по посадах і статі), генерація графіку з урахуванням доступності/закріплених змін/відсутностей, призначення водіїв і трекінг поїздок, облік годин і фінанси (зарплати + рахунки клієнтам), рекрутинг-CRM (воронки), компанії/фабрики/посади, документи працівників, розсилки та сповіщення.

---

## Архітектура

Монорепо на **pnpm workspaces**. Один Node-процес (`@workspace/api-server`) обслуговує все одразу:

```
Express API (/api/*)  ─┐
Статика веб-панелі     ├─ один процес `grafik-bot` (pm2)
Telegraf-бот (polling) ─┤
node-cron планувальник ─┘
        │
        ├── PostgreSQL (Drizzle ORM, схема в lib/db)
        ├── Google Sheets (доступність працівників)
        ├── Google Drive (експорт Excel-графіків, звіти)
        └── SMTP (надсилання графіку клієнту, nodemailer)
```

**Workspace-пакети:**

| Шлях | Пакет | Призначення |
|------|-------|-------------|
| `artifacts/api-server` | `@workspace/api-server` | Бекенд: Express 5 + Telegraf-бот + cron. Збірка через esbuild у `dist/index.mjs`. Див. [README](artifacts/api-server/README.md) |
| `artifacts/web` | `@workspace/web` | Адмінпанель: React 19 + Vite + Tailwind v4. Див. [README](artifacts/web/README.md) |
| `lib/db` | `@workspace/db` | Drizzle-схема — єдине джерело правди для БД. Див. [README](lib/db/README.md) |
| `artifacts/mockup-sandbox` | `@workspace/mockup-sandbox` | Пісочниця для UI-макетів. Не частина прод-системи |
| `lib/api-spec`, `lib/api-zod`, `lib/api-client-react` | — | Скафолд OpenAPI/orval. Майже не використовується (лише `routes/health.ts` бере тип з `api-zod`). Реальний контракт API описаний вручну у `artifacts/web/src/lib/api.ts` |
| `scripts` | `@workspace/scripts` | Дрібний workspace для скриптів (наразі placeholder) |

**Потік даних:** веб-панель і бот пишуть у ту саму PostgreSQL через `@workspace/db`. Доступність працівників підтягується з Google Sheets. Затвердження графіку експортує Excel у Google Drive і (опційно) надсилає клієнту на email. Бот працює у **long-polling** режимі (без webhook).

---

## Команди

```bash
# Встановлення (тільки pnpm; npm/yarn заблоковані preinstall-скриптом)
pnpm install

# Розробка
pnpm --filter @workspace/api-server run dev    # збірка + запуск бекенду+бота (порт з $PORT, зазвичай 8080)
pnpm --filter @workspace/web run dev           # Vite dev-сервер веб-панелі (HMR)

# Перевірка типів і збірка
pnpm run typecheck                             # типи по всіх пакетах (спершу libs, потім artifacts)
pnpm run typecheck:libs                        # тільки lib/* (потрібно після зміни схеми БД)
pnpm run build                                 # typecheck + збірка всіх пакетів
pnpm --filter @workspace/api-server run build  # тільки бекенд → dist/index.mjs (esbuild)
pnpm --filter @workspace/web run build         # тільки веб → artifacts/web/dist

# Тести
pnpm --filter @workspace/api-server run test   # node --test (напр. bot/time.test.ts)

# Прод-процес (pm2)
pm2 start ecosystem.config.cjs                 # старт (процес `grafik-bot`)
pm2 restart grafik-bot                         # перезапуск після збірки
pm2 logs grafik-bot                            # логи
pm2 save                                       # зберегти список процесів

# Зміни схеми БД — вручну через psql (див. lib/db/README.md), напр.:
psql "$DATABASE_URL" -c "ALTER TABLE ... ;"
```

**Обовʼязкові env-змінні** (файл `.env` у корені, **не комітиться**):
`PORT`, `DATABASE_URL` (Postgres), `TELEGRAM_BOT_TOKEN`, `SESSION_SECRET` (підпис сесійних cookie), `GOOGLE_SERVICE_ACCOUNT_JSON` + `GOOGLE_SHEETS_ID` (Sheets/Drive), `TELEGRAM_BOT_USERNAME` (для invite-посилань). Опційні: `CORS_ORIGINS`, `WEB_DIST`, SMTP-змінні для email.

Деплой на VPS (Caddy + pm2 + PostgreSQL) описаний у [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

---

## Правила розробки

- **Схема БД** живе лише в `lib/db/src/schema/workers.ts`. Після її зміни запусти `pnpm run typecheck:libs`, щоб перебудувати декларації перед типчеком artifacts.
- **Міграції — вручну через `psql`.** `drizzle-kit push` ненадійний у non-TTY; зміни накатуються SQL-командами (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`). Тримай SQL та схему синхронними.
- **i18n за патерном «укр-рядок-як-ключ».** Веб: `artifacts/web/src/lib/i18n.tsx` (`t()`, словник uk→en). Бот: `artifacts/api-server/src/bot/i18n.ts` (`t`/`tb`/`bhears`). Додаючи новий текст — додай і EN-переклад; перевір дублікати ключів:
  `grep -oE '^  "[^"]+":' src/lib/i18n.tsx | sort | uniq -d` (дублі дають помилку TS1117).
- **Система багатомовна.** Кожна нова функція з текстами має одразу враховувати i18n (веб — uk/en; бот працівника — 5 мов; офіс/водій-бот — uk/en): не хардкодити один рядок там, де інтерфейс уже перекладається.
- **Мова документів — польська.** Усі документи, що формуються і скачуються (Excel-графіки, звіти, файли для клієнтів), — **польською мовою**, якщо явно не вказано інше.
- **Імена працівників — лише латиницею** (польський алфавіт). Реєстрація в боті відхиляє кирилицю; якщо кириличне ім'я все ж потрапило в базу — виправляємо вручну. Сортування імен — локаль `pl`.
- **Tailwind v4:** класи мають бути присутні в коді буквально (сканер не бачить динамічних рядків). Повні класи виписані у `artifacts/web/src/lib/colors.ts` (`bg-*-500`, `border-t-*-500`, `bg-*-100 text-*-700`).
- **Ролі та доступи:** `owner | scheduler | driver` (мапа можливостей продубльована: `artifacts/api-server/src/lib/roles.ts` + `artifacts/web/src/lib/roles.ts`). Ролі призначає **лише головний адмін** (`admins.is_main`, Yuriy id=1). У бота **немає** шляху видати `is_main`.
- **Фінансові поля — лише для owner** (ставки, рахунки): і в API (фільтрація відповіді), і в UI.
- **Безпека:** не комітити `.env` (у `.gitignore`); приватний SSH-ключ не розкривати; `pnpm-workspace.yaml` має `minimumReleaseAge` (захист від supply-chain) — не вимикати.
- **Бот — лише один polling-інстанс** (інакше Telegram повертає 409). Локальний запуск і прод одночасно конфліктують на одному токені.
- **Стиль коду:** дотримуйся наявних ідіом сусіднього коду (іменування, щільність коментарів). TypeScript strict.

---

## Ключові модулі

| Файл / каталог | Відповідає за |
|----------------|---------------|
| `artifacts/api-server/src/index.ts` | Точка входу: `app.listen` → бот `bot.launch()` (polling) → `startScheduler()`; graceful shutdown |
| `artifacts/api-server/src/app.ts` | Express-застосунок: helmet/cors/cookies, `/api` роутер, віддача статики веб-панелі + SPA-fallback |
| `artifacts/api-server/src/routes/admin-api.ts` | Левова частка REST API (~2500 рядків): працівники, фабрики, компанії, посади, замовлення, графіки, водії, фінанси, рекрутинг, документи, сповіщення |
| `artifacts/api-server/src/routes/auth.ts` | Логін у веб-панель (сесійні cookie, коди через бота) |
| `artifacts/api-server/src/bot/` | Уся логіка Telegram-бота. Див. [README](artifacts/api-server/src/bot/README.md) |
| `artifacts/api-server/src/services/scheduleGenerator.ts` | Алгоритм генерації графіку (3 режими, посади/стать, закріплені зміни, неперервність, врахування відсутностей) |
| `artifacts/api-server/src/services/drive.ts` | Google Drive: побудова Excel-графіку (сегрегація по посаді/статі), експорт, звіти |
| `artifacts/api-server/src/services/sheets.ts` | Читання доступності з Google Sheets |
| `artifacts/api-server/src/services/scheduler.ts` | node-cron: щотижневі нагадування, пресмінні сповіщення, housekeeping |
| `artifacts/api-server/src/services/email.ts` | Надсилання затвердженого графіку клієнту (nodemailer) |
| `artifacts/api-server/src/lib/{auth,roles,payroll}.ts` | Сесії/HMAC, мапа можливостей ролей, розрахунок зарплат (umowa zlecenie) |
| `artifacts/web/src/pages/` | Сторінки адмінпанелі (Schedule, Orders, Workers, Finance, Recruitment, Settings, …) |
| `artifacts/web/src/lib/{api,roles,i18n,colors}.ts(x)` | Fetch-обгортка+типи API, мапа ролей, i18n, кольори/бейджі |
| `lib/db/src/schema/workers.ts` | Уся схема БД (таблиці + Drizzle-типи). Див. [README](lib/db/README.md) |
