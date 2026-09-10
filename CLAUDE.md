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
pnpm --filter @workspace/api-server run test   # node --test: чисті юніти БЕЗ БД (напр. bot/time.test.ts)
# Інтеграційні (*.integration.test.ts, supertest+Postgres) САМІ скіпаються без TEST_DATABASE_URL.
# Обірваний прогін (timeout/обрізаний pipe) лишає процес-сироту, що довбе тестову БД →
# рандомні падіння resetDb (duplicate key на сідингу). Перед прогоном: pkill -f test-hooks

# Ганяти з одноразовою БД (НЕ дев-базою — харнес форсує DATABASE_URL=TEST_DATABASE_URL і truncate):
#   createdb grafik_bot_test && psql -d grafik_bot_test -f deploy/schema.sql && \
#     for m in deploy/migrations/*.sql; do psql -d grafik_bot_test -f "$m"; done
#   TEST_DATABASE_URL=postgres://localhost/grafik_bot_test pnpm --filter @workspace/api-server run test
# CI: job `check` (юніти, без БД) + job `integration` (Postgres-сервіс) — .github/workflows/ci.yml

# Прод-процес (pm2)
pm2 start ecosystem.config.cjs                 # старт (процес `grafik-bot`)
pm2 restart grafik-bot                         # перезапуск після збірки
pm2 logs grafik-bot                            # логи
pm2 save                                       # зберегти список процесів

# Зміни схеми БД — вручну через psql (див. lib/db/README.md), напр.:
psql "$DATABASE_URL" -c "ALTER TABLE ... ;"
```

**Обовʼязкові env-змінні** (файл `.env` у корені, **не комітиться**):
`PORT`, `DATABASE_URL` (Postgres), `TELEGRAM_BOT_TOKEN`, `SESSION_SECRET` (підпис сесійних cookie), `GOOGLE_SERVICE_ACCOUNT_JSON` + `GOOGLE_SHEETS_ID` (Sheets/Drive), `TELEGRAM_BOT_USERNAME` (для invite-посилань). Опційні: `CORS_ORIGINS`, `WEB_DIST`, SMTP-змінні для email, `UPLOADS_DIR` (файли документів працівників), `WEB_APP_URL` (https-URL панелі для Telegram Mini App-кнопки «🖥 Панель призначень» у меню головного водія; без нього кнопка не показується), `GEOIP_ENABLED` (гео входів на `/security`, типово увімкнено; `0`/`false` вимикає зовнішній виклик), алерти (`ALERTS_ENABLED`, `ALERT_TELEGRAM_CHAT_ID`, `ALERT_COOLDOWN_SECONDS` — див. `docs/infrastructure/ALERTING.md`), `FINANCE_ALERTS_ENABLED` (`0` вимикає фінансові бот-алерти головному адміну — надходження/komornik/оплачені фактури; ставити `0` у локальному `.env`, щоб тест-бот не дублював продові сповіщення).

**Google Drive-завантаження** (фото рапортів, Excel-и) йдуть **OAuth-ом від реального користувача** (`GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`, акаунт yuriisydorchuk96@gmail.com). Refresh-токен перегенерується через `node --env-file=.env artifacts/api-server/get-google-token.mjs`. OAuth-застосунок у Google Cloud має лишатися **Published** — у статусі «Testing» токени вмирають кожні 7 днів (`invalid_grant`, ламає ВСІ Drive-операції).

Деплой на VPS (Caddy + pm2 + PostgreSQL) описаний у [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

---

## Схема роботи над задачею

Дворівнева автономія (продубльовано хуком `UserPromptSubmit` у `.claude/settings.json`):

- **Дрібна/зворотна локальна зміна коду** (фікс, поле, колонка, текст, звичайна фіча в межах наявних патернів) — виконуй **одразу, без плану й підтвердження**: цільова навігація → правка → верифікація → короткий звіт.
- **План і підтвердження обовʼязкові:** зміни схеми БД, будь-що на проді (deploy/ssh/psql), видалення чи масові зміни даних, фінансово-критична логіка (сводні/зарплати/фактури/банк), великі кросмодульні фічі.

Навігація — завжди цільова: `PROJECT_MAP.md` (карта + індекс маршрутів) → `docs/API_ROUTES.md` (деталі API) → README пакета; grep потрібну секцію, не читай великі файли цілком.

## Роутинг задач і моделі

Дефолт сесії — **Sonnet 5 (effort high)**. Принцип: fast by default, deep when necessary.

- **Пошук/розвідка** («де це», трасування): grep напряму; для широкого пошуку — субагент Explore (швидка модель), у головний контекст повертається стислий висновок, не дампи файлів.
- **Звичайна задача:** основна сесія, без агентів і церемоній.
- **Кросмодульна фіча:** незалежні ділянки розвідуються паралельними Explore-агентами; реалізація — в основній сесії.
- **Ескалація на Fable 5** (важкий root-cause, архітектурні рішення, фінансово-критичний движок): спершу зібрати докази дешево, потім передати конденсований пакет (PROBLEM / EXPECTED / ACTUAL / REPRO / EVIDENCE / FILES / ATTEMPTS / HYPOTHESIS), а не сире репо. Effort high; **xhigh — лише для реально важких архітектурних/системних/фінансово-критичних задач.**
- Після 2 невдалих варіацій фіксу — стоп, збір доказів, ескалація. Розвідку зупиняй, щойно нова інформація вже не змінить рішення.

## Верифікація (пропорційно ризику)

- Дрібне / веб-UI: `pnpm run typecheck` (можна пакетно через `--filter`).
- Бекенд: typecheck + build api-server; зачеплені юніти — `run test`.
- Фінлогіка/парсери: + інтеграційні тести з `TEST_DATABASE_URL` (зміна парсера = онови фікстуру).
- Прод: лише через скіл `/deploy` (повний чеклист). Після білда бекенду локально — `pm2 restart grafik-bot`, інакше зміни не потраплять у процес.

«Код написаний» ≠ «готово»: фічу спершу прожени сам (UI — скрін через скіл web-screens).

### Друга думка: Antigravity (`agy`) і Codex (`codex`)

Локально стоять два зовнішні агенти, залогінені підписками Yuriy (не API-ключами): **Antigravity CLI** `agy` (Google AI Pro: Gemini 3.1 Pro/3.8 Flash, Claude Opus 4.6) і **Codex CLI** `codex` (ChatGPT; також MCP-сервер `codex`). Використовуй їх як **незалежне ревʼю**, не як заміну власного аналізу:

- **Коли обовʼязково:** перед кожним деплоєм (`/deploy`) і перед «тестуй» по батчу, що зачіпає фінанси/зарплати/легальність, — прогнати diff через **обох** і перевірити кожну знахідку по коду. Коли корисно: другий погляд на складну логіку, великий файл цілком у `agy` (довгий контекст).
- **Як:** `agy -p "<завдання + diff>" --model gemini-3.1-pro-high --mode plan --output-format text` (diff вставляти у промпт, stdin не читає); `codex exec --sandbox read-only "<завдання + diff>"`. Обидва — лише read-only режими.
- **Результати — не істина.** Gemini вигадує помилки (смоук 07.09: «неіснуюче поле», яке існувало); кожну знахідку звіряй grep-ом перед тим, як показати користувачу, і кажи, що підтвердилось, а що ні.
- **Що НЕ слати** (рішення власника): `.env`, дампи/вибірки БД, персональні дані працівників, фінансові цифри з бази. Лише код і diff.
- Логін злетів → `codex login`; для `agy` потрібен pty (`expect`), вікно 60 с, лінк відкривати **один раз**.

## Правила розробки

- **Схема БД** живе лише в `lib/db/src/schema/workers.ts`. Після її зміни запусти `pnpm run typecheck:libs`, щоб перебудувати декларації перед типчеком artifacts.
- **Міграції — вручну через `psql`.** `drizzle-kit push` ненадійний у non-TTY; зміни накатуються SQL-командами (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`). Тримай SQL та схему синхронними. **Порядок накату = алфавіт назв файлів** (CI і `/deploy` роблять `for m in deploy/migrations/*.sql`): файл, що змінює таблицю з «пізнішого» файла, впаде на проді — дата в назві має йти після залежності. Перед великим батчем — сухий прогін на копії прод-дампу. Дані-сіди (реквізити фірм, шаблони) теж ідуть міграціями, ідемпотентно. На проді запускати **лише файли, яких там ще не було** (`git diff --name-only <прод-коміт>..HEAD -- deploy/migrations`): `UPDATE … WHERE col = '[]'` — одноразовий сід, повторний прогін затирає свідомо спорожнені значення (інцидент 08.09.2026, сповіщення ролі OnTon).
- **i18n за патерном «укр-рядок-як-ключ».** Веб: `artifacts/web/src/lib/i18n.tsx` (`t()`, словник uk→en + **частковий** uk→ru лише для водійських сторінок). Бот: `artifacts/api-server/src/bot/i18n.ts` (`t`/`tb`/`bhears`; `BOT_EN` повний, `BOT_RU` частковий — лише водійський досвід). Прогалини в RU-словниках = український текст, **за дизайном** (офісні рядки на ru не перекладаємо). Додаючи новий текст — додай EN (та RU, якщо рядок водійський). Дублікати ключів у межах одного словника ловить `tsc` (TS1117); `uniq -d` по всьому файлу дає фальш-спрацювання (ключі легально повторюються у двох словниках).
- **Система багатомовна.** Кожна нова функція з текстами має одразу враховувати i18n (веб — uk/en; бот працівника — 5 мов; офіс-бот — uk/en; водій у боті — uk/en/ru): не хардкодити один рядок там, де інтерфейс уже перекладається.
- **Мова документів — польська.** Усі документи, що формуються і скачуються (Excel-графіки, звіти, файли для клієнтів), — **польською мовою**, якщо явно не вказано інше.
- **Імена у згенерованих файлах — КАПСОМ.** Будь-яка таблиця, що формує система (скачування з сайту, Drive-експорти, email клієнту), пише імена/прізвища через `nameCaps` з `services/drive.ts` (`toLocaleUpperCase("pl-PL")`); сортування — по оригінальному імені. Нова експортна поверхня мусить застосовувати той самий хелпер.
- **Імена працівників — лише латиницею** (польський алфавіт). Реєстрація в боті відхиляє кирилицю; якщо кириличне ім'я все ж потрапило в базу — виправляємо вручну. Сортування імен — локаль `pl`.
- **Tailwind v4:** класи мають бути присутні в коді буквально (сканер не бачить динамічних рядків). Повні класи виписані у `artifacts/web/src/lib/colors.ts` (`bg-*-500`, `border-t-*-500`, `bg-*-100 text-*-700`).
- **Темна тема веб-панелі — перевизначення CSS-змінних** (`web/src/index.css`, блок `.dark`): Tailwind-утиліти йдуть через `var(--color-*)`, тож стандартні шкали (`bg-white`, `slate-*`, бейджі `bg-*-100 text-*-700`) перетемнюються автоматично — нову верстку роби ними, **без hex-хардкодів** у класах/інлайн-стилях. Клас `dark` на `<html>` ставить `lib/theme.ts` (light/dark/system, localStorage + анти-спалах скрипт в `index.html`; у Telegram Mini App «system» = тема Telegram); перемикач — у `Layout.tsx`. Фон сторінки — токен `bg-page`; графіки recharts не вміють CSS-var у пропсах — бери кольори з `useChartTheme()` (`lib/theme.ts`); точкові дарк-фікси (`text-white`, скрим `bg-slate-900/40`) живуть unlayered у `index.css`.
- **Ролі та доступи — динамічні.** Ролі веб-панелі живуть у БД-таблиці `roles` (`pages` jsonb + `caps` jsonb; системні `owner`/`scheduler`/`driver` + кастомні). Каталоги capability/сторінок продубльовані: `artifacts/api-server/src/lib/roles.ts` ↔ `artifacts/web/src/lib/roles.ts` — тримати синхронними. Гейти API — `requireCap`/`requireAnyCap` (`editData`, `viewFinance`, `factoryRates`, `assignDrivers`, `deleteWorkers`, `svodni`, `svodniSensitive`); `owner` — незмінний суперюзер (повний доступ у коді, незалежно від рядка в БД). Ролі/користувачів редагує **лише головний адмін** (`admins.is_main`, Yuriy id=1, `requireMainAdmin`); у бота **немає** шляху видати `is_main`. Нова сторінка = ключ у `PAGE_KEYS` обох `roles.ts` + `UPDATE roles SET pages = pages || '["/шлях"]'` для потрібних ролей.
- **Глобальні авторизаційні гейти роутерів — скоупити по префіксу шляху:** `router.use("/bank", requireCap("viewFinance"))`, не голий `router.use(requireCap(...))`. Неупакований use-гейт в Express зачіпає і прохідні запити до роутерів, змонтованих нижче в `routes/index.ts` (латентний баг до 12.08.2026: роль без viewFinance не діставалась до /cash, /cost-invoices, /fuel). Стосується кожного нового роутера з власним гейтом.
- **Фінансовий блок — правила в [docs/rules/FINANCE_RULES.md](docs/rules/FINANCE_RULES.md); прочитай перед будь-якою зміною** у сводних/зарплатах/авансах/фактурах/KSeF/банку/касі/P&L (акруал M−1, канон полів-двійників, правила konto/готівки фабрик, Drive-архів і журнал змін фактур, заборона матчингу «по сумі», пріоритет рапортів над явками, фікстури парсерів). Найважливіше: **фінансові поля — лише owner/`viewFinance`** (виняток — cap `factoryRates`: тільки ставки в налаштуваннях фабрики), і в API, і в UI.
- **Invite/привʼязка Telegram — лише криптотокеном** (`lib/invite.ts` `randomInviteCode`, base32 ≥12 симв.), ніколи не послідовним id і не `Math.random`. Працівник привʼязується через `?start=emp<invite_code>` (одноразовий, обнуляється при claim), водій — `drv`, адмін — `adm`. `worker_code` — **публічний** ідентифікатор для показу, **не** секрет привʼязки (послідовний код як секрет був регресією: давав перебірне захоплення непривʼязаних профілів).
- **CSRF-захист — кастомний заголовок.** Гард на `/api` (`app.ts`) вимагає `X-Requested-With: grafik` на всіх мутаціях (POST/PATCH/PUT/DELETE); без нього — `403 {"error":"csrf"}`. Виняток — `/auth/login` і `/auth/verify-2fa` (сесії ще нема). Веб-клієнт шле заголовок через обгортки `api()`/`upload()` (`web/src/lib/api.ts`) — **будь-який новий fetch до `/api` має теж його слати** (або ендпойнт додається у виключення). Файл/Excel-лінки — GET, гардом не зачіпаються. Бот polling-ом через `/api` не ходить. Завантажені документи віддаються з `X-Content-Type-Options: nosniff`, а їх MIME **валідується магічними байтами** (`lib/uploads.ts` `sniffDocMime`), не заявленим клієнтом типом.
- **Сесії веб-панелі — відстежувані й відкликувані.** HMAC-токен вшиває `tv` (версія) **і** `sid` (id рядка `admin_sessions`); `authRequired` щозапиту звіряє обидва: `payload.tv` з `admins.token_version` (bulk-ревок) і наявність/`revoked_at` сесії (per-session ревок). Зміна пароля (бот `web_login:password`, API `reset-web`) і «вийти скрізь» **мусять** інкрементити `token_version` (`sql\`token_version + 1\``); logout ревокає лише поточну сесію (`revoked_at`). Кожен вхід пише рядок `admin_sessions` + подію в `login_events` (успіх/невдача) — сторінка `/security` (лише `is_main`). 2FA-код і invite-коди — крипто (`crypto.randomInt` / `randomInviteCode`), не `Math.random`. `last_seen_at` оновлюється з тротлінгом (раз/5хв), щоб не писати щозапиту. Гео — best-effort `lib/clientInfo.ts` (зовнішній keyless `ipwho.is`, fire-and-forget, гейт `GEOIP_ENABLED`, приватні IP пропускаються).
- **Бот-адмінство — лише через `getAdmin`/`isAdmin` з `bot/roles.ts`:** вони фільтрують веб-роль `driver` (таких людей у боті веде рядок у `drivers`, вкл. `isHeadDriver`). Прямий select з `adminsTable` для гейтів — регресія.
- **Меню бота — через хелпери:** працівнику `workerMenuFor(worker, lang)` (обрізається під налаштування фабрики), водієві `driverMenuFor(driver, lang)` (кнопка зміни залежить від відкритого workday). Голі `workerMenu`/`driverMenu` повертають сховані кнопки.
- **Матчинг введених вручну імен — через `bot/workerMatch.ts`** (`matchWorker`: транслітерація кирилиці, польські діакритики, порядок слів, одрукування). Не писати нових `includes`-матчів по імені. Невпевнений матч = inline-вибір кандидатів водієм; непривʼязані `unplanned_workers` (`worker_id NULL`) графіковий привʼязує у веб-графіку (`POST /unplanned/:id/link` — створює явку present).
- **Стани вводу в боті** показують `cancelKb(lang)`, а не `removeKeyboard()` — глобальний hears «✖️ Скасувати» дає вихід з будь-якого діалогу. Вільний текст (імена тощо) у Markdown-повідомленнях — через `mdSafe()`; текст із URL (назви зупинок) — через `mdSafeWithLinks()` (URL стає клікабельним `[📍 Мапа](url)`; голий `mdSafe` з'їв би `_` з лінка — мертве посилання). Глобальний fallback у `bot/instance.ts` повторює відправку без parse_mode при «can't parse entities» — обгортка `callApi` **на прототипі `Telegram`**: Telegraf створює новий інстанс на кожен update, тож патч лише `bot.telegram` не покриває `ctx.reply`/`editMessageText` (регресія 08.2026 — «Інфо фабрики» мовчки падало, див. INCIDENTS).
- **Місячні звіти — за фактичною датою зміни.** Тиждень легально перетинає межу місяця: бери тижні з запасом (`weekFromForMonth`, −6 днів) і фільтруй кожну зміну за датою (`entryDateStr`). Стосується і фінансів (`computeFinanceRange`). Дати-рядки рахуй рядком, **не** `new Date(...).toISOString()` — прод-сервер у Europe/Berlin, і toISOString зрізає день.
- **Модуль «Задачі» — лише офіс, автозадачі через правила, не через нові крони.** Нове джерело автозадач = код у `AUTO_RULE_DEFS` (`services/taskAutoRules.ts`) з `source_key` (дедуп/auto_resolved) і групуванням по фабриці понад `groupAbove`; виконавець — ланцюжком `resolveAssignee` (відповідальний фабрики → графікова для пропусків → фолбек правила → головний), не хардкод id. Бот-сповіщення про задачі — тип `tasks` у `roles.notify` через `notifyAdminById`; масові розсилки обмежені (нагадування ≤10/адміна/прогін, дайджест — топ-5 з кнопками). Групові задачі/зустрічі — cap `tasksGroup`, контроль/перепризначення — `tasksManage`. Дати задач — рядки `YYYY-MM-DD` у Europe/Warsaw (`warsawToday`, `dateStr`), не `toISOString`. **Документи в працівника просить система, не офіс** (рішення 06.09.2026): типи з `document_types.self_service` + Telegram → `services/docRequests.ts` (запит/нагадування в бот, публічний лінк `/docs/:token`), офісна задача лише «перевірити файл» (одразу при завантаженні) або «не надіслав» після мовчання; будь-який новий запит документа — через `sendDocumentRequest`, не голий `requested_at`. **Строки «спливає/терміново» — лише з правила `defaults.lead_days`** (жовта 24 дн. / червона 7): бекенд `loadLeadDays()`, веб `useLeadDays()`/`expiryTone()`; не хардкодити 14/30 днів у нових поверхнях.
- **Життєвий цикл працівника — через сервіси, не прямі UPDATE** (рішення 08.09.2026). Звільнення — лише `fireWorker()` з `services/workerFire.ts` (веб `/workers/:id/fire`, бот «🔥 Звільнити», крон виповідзення): журнал `worker_changes`, закриття чинних умов датою, видалення НЕРОЗІСЛАНИХ записів графіку після дати, тригери шаблонів, ланцюжок звільнення (`services/terminationFlow.ts`: ZUS ZWUA-задача одразу; świadectwo pracy з шаблону kind `swiadectwo` — генерується без підпису працівника й без підтвердженої анкети (`generateContract({allowUnverified})`), задача графіковій з дією «Затвердити й надіслати» → email з анкети або Telegram; сід шаблону за pomocniczym wzorem — міграція `2026-09-09-swiadectwo-template.sql`). **Подієві документи фірми (`EVENT_KINDS` у `services/contracts.ts`: `swiadectwo`, `zaswiadczenie`, `wypowiedzenie`, `aneks`) в автонабір «Згенерувати документи» не входять — лише явним `templateIds` з ланцюжків (`services/contractEndDocs.ts`).** Рішення власника 10.09.2026: **świadectwo pracy не видаємо** (шаблон вимкнено міграцією). Кінець умови (`date_to` настав, працівник активний, чинної наступної умови на фабрику нема) → задача-рішення графіковій, правило `contract_end`: дія «Звільнити» (`fireWorker` датою кінця) або «Аннекс» (`POST /contracts/:id/annex {dateTo}` → документ kind `aneks` одразу на підпис; після підпису обома `date_to` оригіналу подовжується у `finalizeContractSignature` за маркером `data._extendsContractId`). При звільненні (`terminationFlow` → `issueTerminationDocs`): zaświadczenie o zatrudnieniu на кожну підписану умову (печатка фірми на чернетку `stampDraftWithCompany` → approved) і wypowiedzenie **від імені працівника**, якщо умову закрито раніше її кінця (безстрокова теж); обидва — задача `termination_doc` з дією `send_sign` (`sendContractForSignature`, без бандлу), після підпису працівника фірма підписує автоматично (`data._autoFinalize`, `routes/sign.ts`). Wniosek chorobowe (kind `wniosek_chorobowe`) у сталий пакет входить лише за `worker_questionnaires.ankieta_skladka_chorobowa`; ZCNA — лише на окреме прохання працівника (не в пакеті). Виповідзення = `workers.termination_date` (запланована дата звільнення, `POST /workers/:id/termination`, крон 00:05 звільняє в цю дату). Звільнений не має зʼявлятись у доступності/резерві графіку/Sheets-синку (той створює дубль-профіль, якщо матчити лише активних — матчимо всіх і пропускаємо звільнених). **Перший робочий день** — `workers.first_work_date` (`services/firstWorkDate.ts`: з першої явки `present` у ЗАТВЕРДЖЕНОМУ тижні, ставиться при позначенні явки і нічним бекфілом, ручне значення не перезаписується); саме від нього рахуються обовʼязки роботодавця (powiadomienie UA 7 днів через `employerSinceOf`), НЕ від `employment_start_date` (та — фінансова, стаж Agram). **Powiadomienie UA — двоступеневий ланцюжок `services/uaNotification.ts`** (правило `ua_notification`): групова задача графіковій на N-й день роботи → «Вислати» → групова задача виконавцю ступеня 2 (`params.stage2AdminId`) з карткою даних форми PSZ-PPWPU (`uaCard`) і завантаженням підтвердження прямо з задачі (створює документ `powiadomienie_ua`); людина зникає зі списку, коли документ у профілі. Офіційного API praca.gov.pl немає (HRappka автоматизує портал логіном користувача) — автоматизація подачі відкладена окремим етапом.
- **Веб-анкета працівника (`/passport-scan/:token`) — суворі правила в одному місці** (рішення 08.09.2026): усі поля обовʼязкові, лише латиниця (кирилиця відхиляється), формати з контрольними сумами (PESEL + збіг з датою народження, NIP, рахунок — лише польський NRB/PL-IBAN 26 цифр, індекс `XX-XXX`, телефон, email, вік 16–80, термін паспорта в майбутньому), urząd/NFZ — лише зі списків, у кінці 5 згод RODO короткими рядками з обовʼязковими галочками (`consents*` в `worker_questionnaires`, версія тексту `CONSENTS_VERSION`). Правила — `api-server/src/lib/questionnaireRules.ts`, **побайтова копія** у `web/src/lib/questionnaireRules.ts` (guard-тест); клієнт підсвічує поле, сервер відповідає `400 {fields: {поле: код}}` — нічого не ігнорується мовчки. Працівник вводить лише 7+7 структурованих полів адреси; вільнотекстові `address_pl/address_registered/postal_code/city` для старих плейсхолдерів сервер збирає сам. Адреса urzędu skarbowego — з офіційного реєстру KAS (`lib/taxOfficeAddresses.ts`, 380 з 400; фолбек — ручне поле в офісній анкеті). Офісний PUT анкети в панелі лишається мʼяким (часткове збереження).
- **Статус для виплат — лише через `services/effectiveStatus.ts`** (рішення 06.09.2026): повністю оформлений за документами → статус із кешу `worker_legality` (source `documents`), інакше ручне `workers.legal_status` (`manual`) / порожнє (`none`). Payroll-код (сводна, /hours, /workers) бере `effectiveView(w, cache)` і далі читає `w.legalStatus/isStudent` як раніше; движок легальності `workers.legal_status` **не пише** і payroll-код движок **не імпортує** (гард `legality.guard.test.ts`). Сводна знімає снапшот у `svodni_rows.legal_status/legal_source` на момент формування рядка; зміна за документами йде в журнал `worker_changes` (`effectiveLegalStatus`) і застосовується лише після «Прийняти» в профілі або ревʼю при розлоку.
- **`driver_shift_assignments.kind`** = `delivery | pickup` («забрати зі зміни»). Усе про завіз/посадку/поїздки фільтрує `kind='delivery'`; огляди показують обидва з маркуванням. Детекція прогалин забору продубльована у 2 місцях (`GET /driver-board` + `services/pickupGaps.ts`) — міняти синхронно.
- **Зміни поза `shiftCount` — легальні.** Кількість змін фабрики — лише стандартний набір; записи графіку на вищій зміні (разова зміна дня, або лічильник потім зменшили) не можна ховати. Поверхні ітерують «налаштовані ∪ зміни з записами»; час зміни резолвиться через `services/shiftOverrides.ts` (разові `factory_shift_overrides` мають пріоритет над `factoryShifts()`), тривалість разової зміни фіксується у `hoursOverride` явок. Генерація має режим `augment` («доповнити») — наявні призначення не чіпаються.
- **Вибір тижня графіку — лише через `services/weeks.ts`** (`resolveWeekRow` = «approved ?? останній рядок, вкл. draft», `ensureWeekRow` = створити draft). Статус `approved` **не** означає «тиждень у роботі»: веб-панель працює з draft-тижнями і створює їх при призначенні водіїв наперед. Водійські поверхні (бот, крон-пуші, driver-board) і розсилки МУСЯТЬ резолвити тиждень хелпером — approved-only фільтр там регресія (тиждень 27.07.2026 весь вікенд був draft → водії не бачили призначень). Виняток навпаки: фінансові/облікові вибірки (`/hours`, reliability, сводні) — **свідомо** approved-only. «Мій графік» працівника резолвить тиждень будь-якого статусу, але **показує лише розіслані** записи (`sent_at`); нерозісланий день — «⏳ ще не затверджено», не «вихідний» (поденна логіка у `bot/views.ts` `showWorkerSchedule`, реліз фабрики — `factoryWeekReleaseAt`).
- **`workers.self_transport`** (доїжджають самі) — операційний прапорець (гейт `editData`, не owner-only). Такі люди **виключаються з водійського флоу**: не в списку посадки (`bot/index.ts`), **ніколи не auto-`absent`** при підтвердженні посадки, не рахуються у лічильниках «до забрання» (`GET /driver-board` + `services/pickupGaps.ts` + пресмінне водієві у `scheduler.ts` — усі 3 місця виключають синхронно). Явку/відсутність їм ставить **графікова вручну** у веб-графіку. Свій пресмінний пуш працівник **отримує** (він на зміні). В Excel-графіку клієнту — лишаються.
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
| `artifacts/api-server/src/routes/admin-api.ts` | Левова частка REST API (~5100 рядків; маршрути — `docs/API_ROUTES.md`): працівники, фабрики, компанії, посади, замовлення, графіки, водії, фінанси, рекрутинг, документи, сповіщення |
| `artifacts/api-server/src/routes/auth.ts` | Логін у веб-панель (сесійні cookie, коди через бота) |
| `artifacts/api-server/src/bot/` | Уся логіка Telegram-бота. Див. [README](artifacts/api-server/src/bot/README.md) |
| `artifacts/api-server/src/services/scheduleGenerator.ts` | Алгоритм генерації графіку (3 режими, посади/стать, закріплені зміни, неперервність, врахування відсутностей) |
| `artifacts/api-server/src/services/drive.ts` | Google Drive: побудова Excel-графіку (сегрегація по посаді/статі), експорт, звіти |
| `artifacts/api-server/src/services/sheets.ts` | Читання доступності з Google Sheets |
| `artifacts/api-server/src/services/scheduler.ts` | node-cron: щотижневі нагадування, пресмінні сповіщення, housekeeping, щоденний імпорт витягів (06:00) |
| `artifacts/api-server/src/routes/bank.ts` + `services/bankStatements.ts` | Витяги банків (owner): MT940-парсер (utf8/cp1250/cp852, баланси `:60F:/:62F:`), синк із Drive, SQL-класифікація (`services/bankClassify.ts` — **єдине джерело правди**: bucket-и в коді, категорії витрат — у БД `expense_categories` з owner-CRUD і патерн-DSL; Postgres межа слова `\y`, не `\b`), звірка до злотого. Веб: `web/src/pages/BankStatements.tsx` (/bank) |
| `artifacts/api-server/src/services/email.ts` | Надсилання затвердженого графіку клієнту (nodemailer) |
| `artifacts/api-server/src/lib/{auth,roles,payroll}.ts` | Сесії/HMAC, мапа можливостей ролей, розрахунок зарплат (umowa zlecenie) |
| `artifacts/api-server/src/routes/{fleet,transport,clothing}.ts` | Папка водія в системі (міграція 31.07.2026): автопарк 2.0 (страховки/техогляди/ремонти + крон-алерти), транспортні гроші (журнал виїздів 2022–2026, ставки водій×фабрика, зняття за довіз), спецодяг. Хостели 2.0 (кімнати/платежі/шахматка/umowa) — у `routes/hostels.ts`; каса водія — бокс `hostel` у `routes/cash.ts`. Снапшот джерел і звіти звірки — `data-import/` (gitignored) |
| `artifacts/web/src/pages/` | Сторінки адмінпанелі (Schedule, Orders, Workers, Finance, Recruitment, Settings, …) |
| `artifacts/web/src/lib/{api,roles,i18n,colors}.ts(x)` | Fetch-обгортка+типи API, мапа ролей, i18n, кольори/бейджі |
| `lib/db/src/schema/workers.ts` | Уся схема БД (таблиці + Drizzle-типи). Див. [README](lib/db/README.md) |
