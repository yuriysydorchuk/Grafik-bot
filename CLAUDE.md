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
`PORT`, `DATABASE_URL` (Postgres), `TELEGRAM_BOT_TOKEN`, `SESSION_SECRET` (підпис сесійних cookie), `GOOGLE_SERVICE_ACCOUNT_JSON` + `GOOGLE_SHEETS_ID` (Sheets/Drive), `TELEGRAM_BOT_USERNAME` (для invite-посилань). Опційні: `CORS_ORIGINS`, `WEB_DIST`, SMTP-змінні для email, `UPLOADS_DIR` (файли документів працівників), алерти (`ALERTS_ENABLED`, `ALERT_TELEGRAM_CHAT_ID`, `ALERT_COOLDOWN_SECONDS` — див. `docs/infrastructure/ALERTING.md`).

**Google Drive-завантаження** (фото рапортів, Excel-и) йдуть **OAuth-ом від реального користувача** (`GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`, акаунт yuriisydorchuk96@gmail.com). Refresh-токен перегенерується через `node --env-file=.env artifacts/api-server/get-google-token.mjs`. OAuth-застосунок у Google Cloud має лишатися **Published** — у статусі «Testing» токени вмирають кожні 7 днів (`invalid_grant`, ламає ВСІ Drive-операції).

Деплой на VPS (Caddy + pm2 + PostgreSQL) описаний у [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

---

## Схема роботи над задачею

Кожна **нова** задача (не уточнення в межах поточної) виконується так:

1. Прочитай `PROJECT_MAP.md` і `HANDOFF.md` (CLAUDE.md уже в контексті), якщо ще не читав у цій сесії.
2. Знайди релевантні файли (цільово — grep/карта, не сканування репо).
3. Покажи план і **чекай підтвердження** користувача перед реалізацією.

Це продубльовано хуком `UserPromptSubmit` у `.claude/settings.json` — нагадування інжектиться на кожне повідомлення.

## Правила розробки

- **Схема БД** живе лише в `lib/db/src/schema/workers.ts`. Після її зміни запусти `pnpm run typecheck:libs`, щоб перебудувати декларації перед типчеком artifacts.
- **Міграції — вручну через `psql`.** `drizzle-kit push` ненадійний у non-TTY; зміни накатуються SQL-командами (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`). Тримай SQL та схему синхронними.
- **i18n за патерном «укр-рядок-як-ключ».** Веб: `artifacts/web/src/lib/i18n.tsx` (`t()`, словник uk→en + **частковий** uk→ru лише для водійських сторінок). Бот: `artifacts/api-server/src/bot/i18n.ts` (`t`/`tb`/`bhears`; `BOT_EN` повний, `BOT_RU` частковий — лише водійський досвід). Прогалини в RU-словниках = український текст, **за дизайном** (офісні рядки на ru не перекладаємо). Додаючи новий текст — додай EN (та RU, якщо рядок водійський). Дублікати ключів у межах одного словника ловить `tsc` (TS1117); `uniq -d` по всьому файлу дає фальш-спрацювання (ключі легально повторюються у двох словниках).
- **Система багатомовна.** Кожна нова функція з текстами має одразу враховувати i18n (веб — uk/en; бот працівника — 5 мов; офіс-бот — uk/en; водій у боті — uk/en/ru): не хардкодити один рядок там, де інтерфейс уже перекладається.
- **Мова документів — польська.** Усі документи, що формуються і скачуються (Excel-графіки, звіти, файли для клієнтів), — **польською мовою**, якщо явно не вказано інше.
- **Імена працівників — лише латиницею** (польський алфавіт). Реєстрація в боті відхиляє кирилицю; якщо кириличне ім'я все ж потрапило в базу — виправляємо вручну. Сортування імен — локаль `pl`.
- **Tailwind v4:** класи мають бути присутні в коді буквально (сканер не бачить динамічних рядків). Повні класи виписані у `artifacts/web/src/lib/colors.ts` (`bg-*-500`, `border-t-*-500`, `bg-*-100 text-*-700`).
- **Ролі та доступи — динамічні.** Ролі веб-панелі живуть у БД-таблиці `roles` (`pages` jsonb + `caps` jsonb; системні `owner`/`scheduler`/`driver` + кастомні). Каталоги capability/сторінок продубльовані: `artifacts/api-server/src/lib/roles.ts` ↔ `artifacts/web/src/lib/roles.ts` — тримати синхронними. Гейти API — `requireCap`/`requireAnyCap` (`editData`, `viewFinance`, `assignDrivers`, `deleteWorkers`); `owner` — незмінний суперюзер (повний доступ у коді, незалежно від рядка в БД). Ролі/користувачів редагує **лише головний адмін** (`admins.is_main`, Yuriy id=1, `requireMainAdmin`); у бота **немає** шляху видати `is_main`. Нова сторінка = ключ у `PAGE_KEYS` обох `roles.ts` + `UPDATE roles SET pages = pages || '["/шлях"]'` для потрібних ролей.
- **Бот-адмінство — лише через `getAdmin`/`isAdmin` з `bot/roles.ts`:** вони фільтрують веб-роль `driver` (таких людей у боті веде рядок у `drivers`, вкл. `isHeadDriver`). Прямий select з `adminsTable` для гейтів — регресія.
- **Меню бота — через хелпери:** працівнику `workerMenuFor(worker, lang)` (обрізається під налаштування фабрики), водієві `driverMenuFor(driver, lang)` (кнопка зміни залежить від відкритого workday). Голі `workerMenu`/`driverMenu` повертають сховані кнопки.
- **Матчинг введених вручну імен — через `bot/workerMatch.ts`** (`matchWorker`: транслітерація кирилиці, польські діакритики, порядок слів, одрукування). Не писати нових `includes`-матчів по імені. Невпевнений матч = inline-вибір кандидатів водієм; непривʼязані `unplanned_workers` (`worker_id NULL`) графіковий привʼязує у веб-графіку (`POST /unplanned/:id/link` — створює явку present).
- **Стани вводу в боті** показують `cancelKb(lang)`, а не `removeKeyboard()` — глобальний hears «✖️ Скасувати» дає вихід з будь-якого діалогу. Вільний текст (імена тощо) у Markdown-повідомленнях — через `mdSafe()`; глобальний fallback у `bot/instance.ts` (обгортка `callApi`) повторює відправку без parse_mode при «can't parse entities».
- **Місячні звіти — за фактичною датою зміни.** Тиждень легально перетинає межу місяця: бери тижні з запасом (`weekFromForMonth`, −6 днів) і фільтруй кожну зміну за датою (`entryDateStr`). Стосується і фінансів (`computeFinanceRange`). Дати-рядки рахуй рядком, **не** `new Date(...).toISOString()` — прод-сервер у Europe/Berlin, і toISOString зрізає день.
- **Фінанси: рапорти мають пріоритет над явками.** Для повних місяців діапазону години пари працівник+фабрика беруться з `monthly_reports` (пропорційне масштабування графікових порцій), без рапорту — із затверджених явок; mtd-порівняння (частковий місяць) — завжди по явках.
- **`driver_shift_assignments.kind`** = `delivery | pickup` («забрати зі зміни»). Усе про завіз/посадку/поїздки фільтрує `kind='delivery'`; огляди показують обидва з маркуванням. Детекція прогалин забору продубльована у 2 місцях (`GET /driver-board` + `services/pickupGaps.ts`) — міняти синхронно.
- **`workers.self_transport`** (доїжджають самі) — операційний прапорець (гейт `editData`, не owner-only). Такі люди **виключаються з водійського флоу**: не в списку посадки (`bot/index.ts`), **ніколи не auto-`absent`** при підтвердженні посадки, не рахуються у лічильниках «до забрання» (`GET /driver-board` + `services/pickupGaps.ts` + пресмінне водієві у `scheduler.ts` — усі 3 місця виключають синхронно). Явку/відсутність їм ставить **графікова вручну** у веб-графіку. Свій пресмінний пуш працівник **отримує** (він на зміні). В Excel-графіку клієнту — лишаються.
- **Фінансові поля — лише для owner** (ставки, рахунки, `viewFinance`/`canFinance`): і в API (фільтрація відповіді), і в UI.
- **Фінансовий акруал — «місяць мінус 1»:** фактура/зарплата, виставлена чи виплачена в червні за травневу роботу, належить травню (KSeF `revenueMonthFor`, сводні, звірки ЗП банк=M+1). P&L: дохід нетто, собівартість = повна ЗП (брутто+податки+аванси+хостел); сегменти `main`/`cleaning` не змішувати.
- **Жодного матчингу фінансових записів «по сумі».** Евристичний матчинг фактур↔витягів по сумах був відкинутий власником. Дозволено: точний номер фактури в назві переказу, токени імені (звірка ЗП — строгий прохід, потім fuzzy з авто-підтвердженням лише коли сума сходиться ±2 zł, решта — ручне підтвердження у `payroll_name_matches`).
- **Парсери сводних/KSeF — під тестами** (`services/*.test.ts`): формати таблиць гуляють між містами й місяцями; змінюєш парсер — додай/онови фікстуру. Тест-скрипт використовує `test-hooks.mjs` (безрозширенні імпорти під raw Node) і фейковий `DATABASE_URL`.
- **Безпека:** не комітити `.env` (у `.gitignore`); приватний SSH-ключ не розкривати; `pnpm-workspace.yaml` має `minimumReleaseAge` (захист від supply-chain) — не вимикати.
- **Бот — лише один polling-інстанс на токен** (інакше Telegram повертає 409). Локальна розробка і прод використовують **різні токени** (тестовий бот ≠ прод-бот @ESschedule_grafik_bot), тож конфлікту між ними немає.
- **`bot/index.ts` дробимо опортуністично.** Окремого масового рефакторингу не робимо; але якщо задача і так суттєво зачіпає цілісний блок бота (водійський флоу, флоу працівника, реєстрація/deep-links, офісний флоу) — винеси цей блок у `bot/handlers/` тим самим комітом і перевір смоуком. Дрібні точкові правки — без виносу.
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
| `artifacts/api-server/src/services/scheduler.ts` | node-cron: щотижневі нагадування, пресмінні сповіщення, housekeeping, щоденний імпорт витягів (06:00) |
| `artifacts/api-server/src/routes/bank.ts` + `services/bankStatements.ts` | Витяги банків (owner): MT940-парсер (utf8/cp1250/cp852, баланси `:60F:/:62F:`), синк із Drive, SQL-класифікація (bucket-и/категорії — **єдине джерело правди**; Postgres межа слова `\y`, не `\b`), звірка до злотого. Веб: `web/src/pages/BankStatements.tsx` (/bank) |
| `artifacts/api-server/src/services/email.ts` | Надсилання затвердженого графіку клієнту (nodemailer) |
| `artifacts/api-server/src/lib/{auth,roles,payroll}.ts` | Сесії/HMAC, мапа можливостей ролей, розрахунок зарплат (umowa zlecenie) |
| `artifacts/web/src/pages/` | Сторінки адмінпанелі (Schedule, Orders, Workers, Finance, Recruitment, Settings, …) |
| `artifacts/web/src/lib/{api,roles,i18n,colors}.ts(x)` | Fetch-обгортка+типи API, мапа ролей, i18n, кольори/бейджі |
| `lib/db/src/schema/workers.ts` | Уся схема БД (таблиці + Drizzle-типи). Див. [README](lib/db/README.md) |
