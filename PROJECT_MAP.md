# PROJECT_MAP.md

Технічна карта проєкту **Grafik-bot**. Високорівневий опис системи — у [`CLAUDE.md`](CLAUDE.md); деталі модулів — у README відповідних пакетів.

---

## Карта монорепо

pnpm workspaces. Один процес обслуговує API + статику веб + бота + cron.

```
Grafik-bot/
├── artifacts/
│   ├── api-server/          @workspace/api-server — бекенд (Express+бот+cron) → dist/index.mjs (esbuild)
│   │   └── src/{index.ts, app.ts, routes/, bot/, services/, lib/, middlewares/}
│   ├── web/                 @workspace/web — адмінпанель (React 19 + Vite + Tailwind v4) → dist/
│   │   └── src/{App.tsx, pages/, components/, lib/}
│   └── mockup-sandbox/      пісочниця UI-макетів (поза прод-системою)
├── lib/
│   ├── db/                  @workspace/db — Drizzle-схема (єдине джерело правди)
│   │   └── src/{index.ts, schema/workers.ts}
│   └── api-spec / api-zod / api-client-react   OpenAPI/orval-скафолд (майже не використовується)
├── scripts/                 дрібний workspace (placeholder)
├── deploy/                  Caddyfile, DEPLOY.md, build.sh, schema.sql
├── ecosystem.config.cjs     pm2 (процес `grafik-bot`)
├── CLAUDE.md / HANDOFF.md / PROJECT_MAP.md / replit.md(legacy)
└── pnpm-workspace.yaml, tsconfig.base.json, .env (не комітиться)
```

---

## Основні entry points

| Що | Файл | Нотатки |
|----|------|---------|
| Процес бекенду | `artifacts/api-server/src/index.ts` | `app.listen($PORT)` → `loadStates()` → `bot.launch()` (polling) → `startScheduler()`; graceful shutdown |
| Express-застосунок | `artifacts/api-server/src/app.ts` | helmet/cors/cookies/pino → `/api` → статика `web/dist` + SPA-fallback |
| Роутер API | `artifacts/api-server/src/routes/index.ts` | монтує health + auth + admin-api |
| Telegram-бот | `artifacts/api-server/src/bot/index.ts` (+ `instance.ts`) | усі обробники; запуск з index.ts |
| Веб-SPA | `artifacts/web/src/main.tsx` → `App.tsx` | роути wouter, гард за роллю |
| Схема/клієнт БД | `lib/db/src/index.ts` (+ `schema/workers.ts`) | експорт `db` + таблиці/типи |

---

## API routes

Префікс `/api`. Авторизація: сесійний cookie `grafik_session` (`authRequired`); мутації під `requireRole(...)`; керування адмінами — `requireMainAdmin`. Фінанси — owner only.

**Auth:** `POST /auth/login`, `POST /auth/verify-2fa`, `POST /auth/logout`, `GET /auth/me` · **Health:** `GET /healthz`

**Працівники/документи:** `GET/POST /workers`, `GET/PATCH /workers/:id`, `POST /workers/:id/fire|restore`, `GET /workers/:id/invite`, `GET/POST /workers/:id/documents`, `PATCH/DELETE /worker-documents/:id`, `GET/POST/PATCH/DELETE /document-types`

**Довідники:** `GET/POST/PATCH/DELETE /companies`, `GET/POST/PATCH/DELETE /positions`, `GET/POST/PATCH /factories`, `GET /factories/:id/join-link`

**Водії:** `GET/POST/PATCH/DELETE /drivers`, `GET /drivers/:id/invite`, `GET /driver-board`, `GET /driver-days/:id`

**Замовлення/доступність:** `GET/PUT /orders`, `GET /availability`, `GET /availability/missing`, `POST /availability/remind`

**Графік:** `GET /weeks`, `GET /schedule`, `GET /schedule/excel`, `POST /schedule/generate`, `POST /schedule/approve`, `POST /schedule/entry`, `PATCH/DELETE /schedule/entry/:id`, `PATCH /schedule/entry/:id/status`, `PUT /schedule/driver-assignments(/by-driver)`, `POST /schedule/driver-assignments/copy-week`, `POST /schedule/notify(-workers|-driver|-drivers)`

**Облік/відсутності:** `GET /hours`, `GET /worker-days/:id`, `POST /worker-days/:id/add-shift`, `PATCH /worker-days/entry/:id`, `GET /absences`, `GET /absence-requests`, `POST /absence-requests/:id/approve|reject|substitute`, `GET /hours-reports`, `GET /hours-reports/:id/photo`, `POST /hours-reports/:id/apply|resolve`, `GET /reliability`, `GET /trips`

**Фінанси (owner):** `GET /finance`, `GET /finance/compare`, `GET/PUT /finance/settings`

**Рекрутинг:** `GET/POST/PATCH/DELETE /funnels`, `GET/POST /candidates`, `GET/PATCH/DELETE /candidates/:id`, `POST /candidates/:id/activity|assign|bonus|convert|followup`, `GET /staff`

**Адміни/ролі:** `GET/POST /admins`, `PATCH/DELETE /admins/:id`, `PATCH /admins/:id/role`, `POST /admins/:id/invite|reset-web`

**Інше:** `GET /dashboard`, `GET /live` (лайв-зміни), `GET/POST /notifications(/read)`, `POST /broadcast`, `POST /chat/clear`, `GET /reports`, `GET /drive/link`

> `routes/bot.ts` має `POST /webhook`, але **не змонтований** — бот працює в polling.

---

## Bot flow

Telegraf, **long-polling**, один інстанс. Деталі — [`artifacts/api-server/src/bot/README.md`](artifacts/api-server/src/bot/README.md).

- **Вхід:** `bot.start` обробляє deep-links `?start=...` (реєстрація працівника за кодом/фабрикою, привʼязка адміна/водія за invite, вибір мови). Команди: `/adminsetup`, `/getid`, `/invite`.
- **Навігація:** reply-keyboard меню за роллю (`menus.ts`); `bot.hears` (~53, двомовний матч через `bhears`).
- **Дії:** inline-кнопки `bot.action` (~32) — підтвердження відсутностей, мова, редагування графіку.
- **Введення:** `bot.on("text"|"photo"|"document")` у межах активного кроку діалогу.
- **Стан діалогів:** власний (`state.ts`) — in-memory Map + write-through у `user_states` (переживає рестарт; відновлення `loadStates()`).
- **Ролі:** працівник / водій / головний водій / офіс-адмін (керування переважно у веб-панелі).

---

## Cron / jobs

`services/scheduler.ts` (node-cron, **Europe/Warsaw**), шле через `bot`:

| Розклад | Завдання |
|---------|----------|
| `0 {година} * * 0` (нд, типово 18:00) | Нагадування заповнити доступність (кому бракує) + зведення адмінам |
| `*/15 * * * *` | Пресмінні сповіщення (~2 год до старту зміни) працівникам і водієві; дедуп `sentToday` |
| `0 0 * * *` | Скидання дедуп-трекера |
| `0 4 * * *` | Housekeeping: прибирання трекінгу повідомлень + старих `notifications` |

`setReminderHour()` перезапускає завдання. `pruneNotifications()` тримає таблицю обмеженою (30 днів / 300 записів).

---

## Database schema overview

Drizzle, уся схема в `lib/db/src/schema/workers.ts`. Групи таблиць:

- **Довідники:** `companies`, `factories`, `positions`, `factory_positions`, `workers`, `drivers`, `admins`
- **Планування:** `factory_orders`, `availability`, `schedule_weeks`, `schedule_entries`, `schedule_approvals`, `driver_shift_assignments`
- **Операції:** `driver_trips`, `unplanned_workers`, `absence_requests`, `hours_disputes`
- **Рекрутинг:** `funnels`, `candidates`, `candidate_activity`
- **Документи:** `document_types`, `worker_documents`
- **Сервісні:** `notifications`, `user_states`, `bot_messages`, `settings`

Деталі полів — у `lib/db/README.md` та самій схемі. **Зміни — вручну через `psql`** (не drizzle-kit).

---

## Зовнішні інтеграції

| Сервіс | Де | Призначення |
|--------|----|-------------|
| Telegram (Telegraf) | `bot/`, `bot/notify.ts` | бот + усі вихідні сповіщення (polling) |
| Google Sheets | `services/sheets.ts` | доступність працівників (матч за «Прізвище Імʼя») |
| Google Drive | `services/drive.ts` | експорт Excel-графіку (сегрегація посада→стать), звіти |
| SMTP (nodemailer) | `services/email.ts` | надсилання затвердженого графіку клієнту |
| PostgreSQL | `@workspace/db` | основне сховище |

Доступ Google — через `GOOGLE_SERVICE_ACCOUNT_JSON`; таблиця/Drive мають бути розшарені на service account.

---

## Ролі доступу

`owner | scheduler | driver` (мапа можливостей продубльована: `api-server/src/lib/roles.ts` ↔ `web/src/lib/roles.ts`).

- **owner** — повний доступ, фінанси, керування користувачами.
- **scheduler** — планування/довідники/рекрутинг без фінансів і керування ролями.
- **driver** — обмежений (свої екрани).
- **`admins.is_main`** — головний адмін (Yuriy, id=1): **єдиний**, хто призначає ролі (`requireMainAdmin`). У бота немає шляху видати `is_main`.

---

## Production / deploy flow

VPS (Ubuntu) + **Caddy** (HTTPS) + **PostgreSQL** локально + **pm2**. Гайд: [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

```bash
git pull
pnpm install
pnpm --filter @workspace/web run build         # → artifacts/web/dist
pnpm --filter @workspace/api-server run build   # → dist/index.mjs
psql "$DATABASE_URL" -c "…"                      # накатати зміни схеми (за потреби)
pm2 restart grafik-bot && pm2 save
```

Caddy проксіює на `$PORT`; `app.set("trust proxy", 1)` для коректних IP/secure-cookie. pm2 `autorestart` (max_restarts=30).

---

## Ризикові місця

- **Подвійний polling бота** → `409 Conflict`. Рівно один `grafik-bot`; не запускати локальний бот на прод-токені.
- **Схема vs psql.** Немає міграційних файлів — легко розсинхронити код-схему й реальну БД. Завжди накатуй SQL + `typecheck:libs`.
- **Один процес = усе разом.** Падіння кладе і API, і бота, і панель (рятує pm2 autorestart).
- **Tailwind v4** не бачить динамічних класів — лише буквальні (повні класи в `web/src/lib/colors.ts`).
- **i18n-дублі** ключів → TS1117; не забувати EN-переклад + перевірку `uniq -d`.
- **Фінансові поля** мають лишатися owner-only і в API, і в UI.
- **Секрети:** `.env`, `GOOGLE_SERVICE_ACCOUNT_JSON`, SSH-ключ — не комітити/не розкривати. `minimumReleaseAge` у pnpm не вимикати.
- **Google sharing.** Якщо Sheet/Drive не розшарені на service account — доступність/експорт мовчки не працюють.
- **Великі файли:** `bot/index.ts` (~3200) і `routes/admin-api.ts` (~2500) — зміни робити точково, не переписувати масово.
- **Час/зміни** рахуються у Europe/Warsaw — не вводити локальні таймзони у логіку змін.
