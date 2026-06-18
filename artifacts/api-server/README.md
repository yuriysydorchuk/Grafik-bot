# @workspace/api-server

Бекенд системи **Grafik-bot**. Один Node-процес, що поєднує REST API, віддачу веб-панелі, Telegram-бота й cron-планувальник. Загальний огляд системи — у [`/CLAUDE.md`](../../CLAUDE.md).

## Що робить процес

`src/index.ts` піднімає все в одному процесі:

1. `app.listen(PORT)` — Express (`src/app.ts`): `/api/*` роутер + віддача статики `artifacts/web/dist` зі SPA-fallback.
2. `loadStates()` — відновлює незавершені діалоги бота з БД.
3. `bot.launch()` — запускає Telegram-бота в режимі **long-polling** (не `await`, бо promise живе весь час роботи).
4. `startScheduler()` — реєструє cron-завдання (Europe/Warsaw).
5. Graceful shutdown на `SIGINT`/`SIGTERM` (зупиняє cron і бота).

## Структура

```
src/
├── index.ts            точка входу (listen + bot.launch + scheduler + shutdown)
├── app.ts              Express: helmet/cors/cookies/pino, /api, статика веб + SPA fallback
├── routes/
│   ├── index.ts        збирає health + auth + admin-api
│   ├── admin-api.ts    основний REST API (~2500 рядків)
│   ├── auth.ts         логін у веб-панель (сесійні cookie, коди через бота)
│   └── health.ts       healthcheck
├── bot/                Telegram-бот (див. bot/README.md)
├── services/
│   ├── scheduleGenerator.ts  генерація графіку
│   ├── drive.ts              Google Drive + Excel
│   ├── sheets.ts             Google Sheets (доступність)
│   ├── scheduler.ts          node-cron завдання
│   └── email.ts              надсилання графіку клієнту (SMTP)
├── lib/
│   ├── auth.ts         сесії: HMAC-підписані cookie `grafik_session`, requireRole/requireMainAdmin
│   ├── roles.ts        мапа можливостей ролей owner|scheduler|driver (дублюється у веб)
│   ├── payroll.ts      розрахунок umowa zlecenie (брутто→нетто, ZUS, вартість праці)
│   └── logger.ts       pino-логер
└── middlewares/        (наразі порожньо)
```

## Запуск і збірка

```bash
pnpm --filter @workspace/api-server run dev     # build + start (потрібен .env у корені)
pnpm --filter @workspace/api-server run build   # esbuild → dist/index.mjs
pnpm --filter @workspace/api-server run start    # запуск зібраного (node --env-file=../../.env)
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server run test     # node --test (src/**/*.test.ts)
```

Збірка — через `build.mjs` (esbuild, бандлить у єдиний `dist/index.mjs`; pino-воркери — окремими файлами). У проді процес тримає **pm2** (`ecosystem.config.cjs`, імʼя `grafik-bot`).

## Env-змінні

Обовʼязкові: `PORT`, `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `SESSION_SECRET`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEETS_ID`, `TELEGRAM_BOT_USERNAME`.
Опційні: `CORS_ORIGINS` (через кому), `WEB_DIST` (шлях до зібраної панелі), SMTP-змінні для `email.ts`, `NODE_ENV`.

## Як спілкується API ↔ веб

Веб-панель віддається тим самим сервером (same-origin), ходить на `/api/*` із сесійним cookie. CORS типово вимкнено (вмикається лише через `CORS_ORIGINS`). Контракт описаний на стороні веба вручну в `artifacts/web/src/lib/api.ts` (без згенерованого клієнта).

## Сервіси

- **scheduleGenerator** — будує `schedule_entries` із замовлень/доступності; 3 режими фабрики (`availability` / `orders` / `all`), розподіл по посадах і статі, закріплені зміни, неперервність тижня, пропуск зголошених відсутностей.
- **drive** — генерує Excel-графік (сегрегація по посаді→статі, колонка `Płeć` K/M), вивантажує в Drive, оновлює звіти.
- **sheets** — зчитує доступність працівників із Google Sheets, матчить за «Прізвище Імʼя».
- **scheduler** — cron-завдання (див. `bot/README.md` → «Cron / scheduler»).
- **email** — надсилає затверджений графік на email клієнта фабрики.

> Зміни схеми БД — лише через `psql` (див. [`lib/db/README.md`](../../lib/db/README.md)), не `drizzle-kit push`.
