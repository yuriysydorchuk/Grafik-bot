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

Префікс `/api`. Авторизація: сесійний cookie `grafik_session` (`authRequired`, HMAC-токен зі вшитим `token_version`); мутації під `requireRole(...)`; керування адмінами — `requireMainAdmin`. Фінанси — owner only. **Відкликання сесій:** `authRequired` звіряє `payload.tv` з `admins.token_version` щозапиту; logout / зміна пароля / reset-web інкрементять версію → всі старі токени адміна миттєво недійсні («вийти скрізь»). 2FA-код — `crypto.randomInt`.

**Auth:** `POST /auth/login`, `POST /auth/verify-2fa`, `POST /auth/telegram-webapp` (вхід із Telegram Mini App: верифікація WebApp `initData` HMAC-ом бот-токена — `lib/telegramWebApp.ts`, під тестами; сесія видається адміну з відповідним `telegram_id`), `POST /auth/web-lang` (мова панелі → `admins.web_lang`; `/auth/me` віддає `lang` з фолбеком на мову водія з бота — localStorage у вебвʼю Mini App не живе), `POST /auth/logout`, `GET /auth/me` · **Health:** `GET /healthz`

**Працівники/документи:** `GET/POST /workers`, `GET/PATCH /workers/:id`, `POST /workers/:id/fire|restore`, `DELETE /workers/:id` (hard-delete, owner), `GET /workers/:id/invite`, `GET/POST /workers/:id/documents`, `PATCH/DELETE /worker-documents/:id`, `POST/GET /worker-documents/:id/file` (аплоуд/стрім файлу, диск `uploads/`), `GET/POST/PATCH/DELETE /document-types`

**Довідники:** `GET/POST/PATCH/DELETE /companies`, `GET/POST/PATCH/DELETE /positions`, `GET/POST/PATCH /factories`, `GET /factories/:id/join-link`

**Водії:** `GET/POST/PATCH/DELETE /drivers` (мутації — `editData` АБО `assignDrivers`: головний водій керує списком і з сайту), `GET /drivers/:id/invite`, `GET /driver-board`, `GET /driver-days/:id`, `GET /mileage` (пробіг по змінах водіїв, з номером авто), `PATCH /driver-workdays/:id` (виправлення пробігу; `editData` АБО `assignDrivers`), `GET/POST/PATCH/DELETE /vehicles` (автопарк; ті самі гейти; видалення м'яке — старі зміни тримають номер у звіті)

**Замовлення/доступність:** `GET/PUT /orders`, `GET /availability`, `GET /availability/missing`, `POST /availability/remind`

**Графік:** `GET /weeks`, `GET /schedule` (віддає і `shiftOverrides` — разові зміни тижня), `GET /schedule/excel`, `POST /schedule/generate` (`augment: true` = «доповнити»: наявні записи не видаляються, заповнюються лише порожні клітинки), `POST /schedule/approve`, `POST/DELETE /schedule/shift-override` (разова зміна на конкретну дату фабрики: № зміни + start/end; правлять `hoursOverride` явок клітинки), `POST /schedule/email` (лист клієнту фабрики: тиждень або день, з Excel-вкладенням), `GET/PUT /email-templates` (шаблон листа, ключі `email_tpl_schedule_*` у `settings`), `POST /schedule/entry`, `PATCH/DELETE /schedule/entry/:id`, `PATCH /schedule/entry/:id/status`, `PUT /schedule/driver-assignments(/by-driver)`, `POST /schedule/driver-assignments/copy-week`, `POST /schedule/notify(-workers|-driver|-drivers)`, `POST /schedule/shift-cancel|shift-restore` (скасування клітинки день+зміна: знімає призначення водіїв, скидає absent, опційні сповіщення працівникам/водіям; entries лишаються scheduled → поза reliability; бот/пуші/pickup-прогалини пропускають скасовані клітинки)

**Облік/відсутності:** `GET /hours` (рядки по парі працівник+фабрика), `POST /hours/report` (ручні години рапорту), `POST /hours/report-remind`, `GET /hours/report-excel` (`cols=` вибір колонок з каталогу `HOURS_XLSX_COLS`, `errorsOnly=1` — лише розбіжності рапорт↔фабрика), `GET /worker-days/:id`, `POST /worker-days/:id/add-shift`, `PATCH /worker-days/entry/:id`, `GET /absences` (пропуски + штрафи: стандарт 300 zł, `justified` виключає з підсумків), `PATCH /absences/:entryId` (виправдання/штраф пропуску), `GET /absence-requests`, `POST /absence-requests/:id/approve|reject|substitute`, `GET /hours-reports`, `GET /hours-reports/:id/photo`, `POST /hours-reports/:id/apply|resolve`, `GET /reliability`, `GET /trips`, `POST /unplanned/:id/link` (привʼязка вписаного водієм позапланового до працівника з бази; створює явку present)

**Аванси:** `GET /advances`, `POST /advances/:id/approve|reject|paid` (`editData`; запит працівник створює в боті)

**Фінанси (owner):** `GET /finance`, `GET /finance/compare`, `GET/PUT /finance/settings`

**Витяги банків (owner, `routes/bank.ts`):** `GET /bank/summary` (метрики періоду: приходи/витрати з ЗП/готівковий рух/виплати власникам/стан на початок-кінець), `GET /bank/expense-categories` (витрати за категоріями), `GET /bank/breakdown` (категорія по фірмах), `GET /bank/balances` (стан по фірмах), `GET /bank/transactions` (фільтри/сортування/`bucket`; пошук по контрагенту/призначенню/типу **і номерах рахунків** — своєму `:25:` та IBAN контрагента `^38`, пробіли ігноруються), `PATCH /bank/transactions/:id/category` + `POST /bank/transactions/recategorize` (ручне/масове перенесення категорії), `GET/POST/PATCH/DELETE /bank/categories` (CRUD категорій витрат; видалення → транзакції в «Інше»), `GET /bank/meta`, `POST /bank/sync` (імпорт MT940 з Drive), `GET/POST/PATCH/DELETE /bank/counterparty-rules` (правила контрагент→категорія)

**Фінансовий блок (owner; деплой-чекліст — `HANDOFF-finance-suite.md`):**
- `routes/cash.ts` — каса: `GET /cash/summary|entries`, `POST /cash/transfer`, CRUD записів, `PATCH …/category`, `POST /cash/sync` (сейфи office/yuriy/tetiana, `cash_entries.box`, `transfer_group`)
- `routes/cashflow.ts` — `GET /cashflow` (потоки + рівняння звірки), `GET /cashflow/entries` (дрил-даун рухів: банк+готівка по категорії, пошук/фільтри/пагінація), `GET /balance` (зріз на кінець місяця: гроші + належності + неоплачені фактури)
- `routes/obligations.ts` — CRUD належностей. Ручний запис — **знімок місяця**: у баланс/чисту позицію входить лише в місяці своєї `arisen_date` (борг, що висить далі, власник вписує в наступний місяць окремим рядком); `settled_at` прибирає з дати закриття
- `routes/invoices.ts` — фактури витрат: CRUD + `POST /invoices/sync` (3 таблиці Faktury Kosztowe, ручні статуси через `manual_*`)
- `routes/pnl.ts` — `GET /pnl?month&segment(main|cleaning)`, CRUD `/pnl/entries` (дохід нетто+брутто; собівартість = повна ЗП; маржа = нетто − собівартість). **Клієнти привʼязані по ID фабрики:** `factories.client_nip` + `factories.pnl_label` — дохід (KSeF матчить покупця по NIP, `clientLabelByNip`; фолбек — регекспи назв) і собівартість (payroll: вкладка → фабрика → pnl_label) зливаються одним канонічним підписом; кілька фабрик одного клієнта (Agram ×2, Eurocash ×3, InPost ×2) ділять NIP/label. `POST /ksef/rematch` перемаплює наявні фактури по NIP (новий клієнт = заповнити client_nip/pnl_label фабриці)
- `routes/payroll.ts` — зведені ЗП: `GET /payroll?month&region&firm`, `/payroll/months|sources|sync|reconcile`, `POST/DELETE /payroll/name-match`, `DELETE /payroll/folders/:id`
- `routes/ksef.ts` — фактури KSeF: `GET /ksef?month&kind(sale|purchase)`, `PATCH /ksef/invoices/:id`, `POST /ksef/sync|rematch`. Продажі: акруал M−1, оплата = номер у назві вхідного переказу; закупівлі (Subject2, довідково, у P&L не йдуть): місяць за датою виставлення, оплата = вихідний переказ з номером і сумою / реєстр Faktury Kosztowe / коректа (однозначна пара)

**Сводні (`routes/svodni.ts`, cap `svodni`; закритий шар — `svodniSensitive`):** місячні сводні виплат по містах/фабриках. `GET /svodni?month`, `GET /svodni/months|unmatched|excel`, `POST /svodni/rows` + `PATCH/DELETE /svodni/rows/:id`, `POST /svodni/link` (привʼязка рядка до працівника), `POST /svodni/from-hours` (заповнення з обліку годин), `POST /svodni/rematch|sync` (синк із Google-таблиць), `POST /svodni/lock` (toggle-лок затвердження: фабрика або ціле місто `factoryLabel=''`; залочене не редагується/не видаляється, from-hours і синк пропускають; **вік «до 26» студентів фіксується локом**: поки сводна відкрита — прапор «на сьогодні» (наближення дати виплати, вона в M+1), при встановленні лока `freezeUnder26AtLock` востаннє перераховує тих, кому 26 виповнилося між розрахунком і затвердженням — прапор/студентська ставка/розклад), `POST /svodni/apply-rates` (`viewFinance`), `GET/POST/PATCH/DELETE /hostels` (утримання за хостели). Чутливий шар (księgowość brutto/netto, готівка, конто) віддається **лише** з `svodniSensitive`. Веб: `/svodni` (`Svodni.tsx`), `/hostels` (`Hostels.tsx`). **Бонуси Agram** (фабрики по id: `AGRAM_FACTORY_IDS` = 12/13 у `services/svodni.ts`): галочки в профілі працівника (`agram_staz_bonus`/`agram_cash_bonus`) + `workers.employment_start_date` — видимість галочок і редагування (галочки+дата, і в PATCH /workers, і в profile-apply `SENSITIVE_TRACKED`) лише з `svodniSensitive` (дата видима всім, редагована — sensitive); ставка нетто рядка = база (профіль ?? стандартна 25.35, крім студентів до 26) + нал +1 + стаж (авто від дати на кінець місяця: ≥30 днів +1, ≥60 днів +1.5, без дати +1; стаж-бонус лише при ≥160 год/міс, нал від годин не залежить (належить лише тим, хто отримує частину ЗП готівкою); студентам до 26 бонуси не додаються — їхня нетто = брутто; `agramBonusPerHour`, під тестами). У профілі тримається **база без бонусів** — from-hours складає, зворотні синки ставок (правка клітинки, apply-rates) бонус віднімають. Wózkowy — без бонусів (галочки зняті). **LST (id=1) — бонусна фабрика теж**: нал-бонус +1 зл/год (та сама галочка `agram_cash_bonus`, стажевого нема; `CASH_BONUS_FACTORY_IDS`/`factoryBonusPerHour` у `services/svodni.ts`); у веб-профілі LST-працівника — рядок «Бонус фабрики» лише з готівковою галочкою. **Резолюція ставок** (`resolveBaseRates`, під тестами): профільна ставка (override; `workers.hourly_rate` тепер nullable, NULL = «авто») → пара посади фабрики (`factory_positions.rate/rate_netto`) → найдешевша посада фабрики (посада в профілі не вказана = «звичайний працівник») → базова пара фабрики (`factories.rate_brutto/rate_netto`); студент до 26 — нетто = брутто (оподаткована профільна нетто ігнорується), бонуси не додаються. EUROCASH — ставка від норм (блок STAWKA EUROCASH), правилами не ведеться, вручну. Використовується у from-hours, перерахунках з профілю (`rowSetFromProfile`), сегментному оверлеї і фіксації віку при локу. **Мульти-контрактні фабрики** (ANDROS: Klinex + Euro Support): якщо на фабриці в місяці працюють люди РІЗНИХ наших фірм, from-hours ділить вкладку сводної по фірмі працівника (`ANDROS KLINEX` / `ANDROS EURO SUPORT` — дзеркально вкладкам таблиці); джерело поділу — `workers.company_id`. P&L лишається обʼєднаним одним клієнтом (NIP той самий). **Зміни профілю з датою набуття:** `POST /svodni/profile-impact` (dry-run: які рядки сводних зачепить зміна від дати) + `POST /svodni/profile-apply` (профіль + журнал `worker_changes` + перерахунок вибраних рядків; залочені — ніколи). Свод-релевантні поля у веб-профілі відкривають модалку «Діє з + превʼю» (cap `svodni`); журнал також пишеться зі звичайного PATCH (effective=сьогодні) і fire/restore; історія — `GET /workers/:id/changes` (таймлайн у профілі). `GET /svodni` віддає `staleLocks` — затверджені області, де профілі змінились після локу (❗ на вкладці). **Сегменти всередині місяця:** зміна оплатних умов (ставка/посада/статус/бонуси) з дати всередині місяця ріже рядок на сегменти (`svodni_rows.segment_of/from/to/label`). Кожен сегмент — «міні-місяць» (`computeSegmented`, під тестами): свій до виплати, свій розклад konto/готівки **за правилами свого статусу** (форма легалізації сегмента — `extras.segLegal`), частка місячних відрахувань пропорційно базі, години повідомлення діляться послідовно (студент до 26 не споживає); батько = Σ сегментів, ставки — min (декларування), payoutPref — місячний, перекриває на батькові. Години ріжуться по явках; рапортна сума — пропорційно явкам у вікнах (без явок — по днях, `splitTotalByWindows` під тестами); години/ставки сегментів правляться в UI (🧩-маркер, розкриття), `POST /svodni/rows/:id/unsplit` — обʼєднати назад. from-hours перерозкладає нові години по наявних межах; агрегатні вибірки (GET, excel, apply-rates, from-hours) фільтрують `segment_of IS NULL`

**Сводна 2.0 — ВИДАЛЕНА (24.07.2026):** код (`routes/svodni2.ts`, `services/svodni2.ts`, `web/pages/Svodni2.tsx`), сторінка `/svodni2`, таблиці `svodni2_rows/columns/locks` (міграція `2026-07-24-drop-svodni2.sql`). Джерело правди — перша сводна `/svodni`. **Штрафи (`routes/penalties.ts`, cap `svodni`):** `GET/POST/PATCH/DELETE /penalties` — ручний реєстр kar по місяцях (дзеркало хостелів), веб `/penalties` (`Penalties.tsx`).

**Рекрутинг:** `GET/POST/PATCH/DELETE /funnels`, `GET/POST /candidates`, `GET/PATCH/DELETE /candidates/:id`, `POST /candidates/:id/activity|assign|bonus|convert|followup`, `GET /staff`

**Адміни/ролі:** `GET/POST /admins`, `PATCH/DELETE /admins/:id`, `PATCH /admins/:id/role`, `POST /admins/:id/invite|reset-web`, `GET/POST/PATCH/DELETE /roles` (динамічні ролі, лише `is_main`)

**Безпека/сесії (`routes/security.ts`, лише `is_main`):** `GET /security/sessions` (активні+недавні сесії веб-панелі: пристрій/IP/гео/час/остання активність, `current`=свій), `GET /security/login-events` (журнал входів: успіх/невірний пароль/невірний 2FA/logout), `POST /security/sessions/:id/revoke` (заблокувати одну), `POST /security/admins/:id/logout-everywhere` (ревок усіх сесій + bump `token_version`). Веб: `web/src/pages/Security.tsx` (`/security`, у навігації лише головному адміну).

**Інше:** `GET /dashboard`, `GET /attention` (лічильники «Потребує уваги» для дашборда: pending-вихідні/аванси, нові коригування годин, невідмічені присутності, зміни без водія, непривʼязані позапланові, незаповнена диспозиційність), `GET /live` (лайв-зміни), `GET/POST /notifications(/read)`, `POST /broadcast`, `POST /chat/clear`, `GET /reports`, `GET /drive/link`

> `routes/bot.ts` має `POST /webhook`, але **не змонтований** — бот працює в polling.

---

## Bot flow

Telegraf, **long-polling**, один інстанс. Деталі — [`artifacts/api-server/src/bot/README.md`](artifacts/api-server/src/bot/README.md).

- **Вхід:** `bot.start` обробляє deep-links `?start=...` (префікси: `emp`=привʼязка працівника, `drv`=водія, `adm`=адміна, `ref`=реферал, `fac`=самореєстрація на фабрику; вибір мови). Усі invite-коди — **криптовипадкові** (`lib/invite.ts` `randomInviteCode`, base32), не послідовні й не `Math.random`; токен працівника одноразовий (обнуляється при привʼязці). Команди: `/adminsetup`, `/getid`, `/invite`.
- **Навігація:** reply-keyboard меню за роллю (`menus.ts`); `bot.hears` (~53, двомовний матч через `bhears`). Головний водій має web_app-кнопку «🖥 Панель призначень» (Telegram Mini App: відкриває `/driver-shifts` панелі з авто-логіном через `POST /auth/telegram-webapp`; зʼявляється лише коли задано `WEB_APP_URL`).
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
| `*/15 * * * *` | Пресмінні сповіщення (~2 год до старту зміни) працівникам і водієві; pickup-нагадування водієві (~60 хв до **кінця** зміни); дедуп `sentToday` |
| `0 19 * * *` | Прогалини забору (pickup) на завтра → головному водієві з inline-вибором водія (`services/pickupGaps.ts`) |
| `0 0 * * *` | Скидання дедуп-трекера |
| `0 4 * * *` | Housekeeping: прибирання трекінгу повідомлень + старих `notifications` |
| `0 6 * * *` | Імпорт банківських витягів MT940 з Drive → `bank_transactions`/`bank_statements` (ідемпотентний, `services/bankStatements.ts`) + каса, фактури витрат, зведені ЗП, KSeF-синк (вкл. `matchKsefPayments`), контрагенти, авто-«виплачено» авансів, попередження про сплив консентів |
| `10 7,11,15,19 * * *` | Оперативний банк (Enable Banking, `services/bankApi.ts`): транзакції+баланси по консентах → одразу матчинг оплат KSeF і авансів; алерти власнику. 4 рази/день — PSD2-ліміт фонових запитів |
| `0 9 1 * *` | Місячний CFO-звіт за попередній місяць (`services/cfo.ts`) |

`setReminderHour()` перезапускає завдання. `pruneNotifications()` тримає таблицю обмеженою (30 днів / 300 записів). Дедуп пресмінних (`sentToday`) віддзеркалюється в `settings` — переживає рестарт pm2.

---

## Database schema overview

Drizzle, уся схема в `lib/db/src/schema/workers.ts`. Групи таблиць:

- **Довідники:** `companies`, `factories`, `positions`, `factory_positions`, `workers` (`self_transport` = доїжджає сам → поза водійським флоу, явку ставить графікова; `worker_code` = публічний послідовний id для показу, `invite_code` = криптотокен привʼязки Telegram через `?start=emp<code>`), `drivers`, `vehicles` (автопарк: номер/марка/місткість; веде головний водій у боті «🚙 Авто» або сайт Водії→Автопарк), `admins`, `roles` (динамічні ролі веб-панелі: pages+caps)
- **Планування:** `factory_orders`, `availability`, `schedule_weeks`, `schedule_entries` (має `sent_at` — «Мій графік» у боті показує лише розіслане; `absence_excused` = виправданий пропуск — поза підсумками/штрафом, `absence_penalty` = override штрафу zł, NULL = стандарт 300, 0 = анульовано), `schedule_approvals`, `driver_shift_assignments` (`kind`: delivery|pickup), `shift_cancellations` (скасовані клітинки week+factory+day+shift, unique), `factory_shift_overrides` (разова зміна: factory+date+shift+start/end, unique; час має пріоритет над `factories.shifts` — резолвиться через `services/shiftOverrides.ts`)
- **Операції:** `driver_trips`, `driver_workdays` (зміна водія: виїзд/повернення + одометр + `vehicle_id`), `unplanned_workers` (`replaces_worker_id` = кого замінив; замінений отримує absent з причиною «заміна» → reliability рахує як скасовано), `absence_requests` (`shift NULL` = вихідний на цілий день; блокує генерацію вже в pending), `hours_disputes`, `advance_requests`, `monthly_reports` (рапорт працівника: unique worker+month+factory)
- **Рекрутинг:** `funnels` (реферальна воронка гарантується на старті — `ensureReferralFunnel()`), `candidates`, `candidate_activity`
- **Документи:** `document_types`, `worker_documents` (файли — на диску `uploads/`, в БД лише метадата)
- **Банківські витяги:** `bank_transactions` (сирі рядки MT940: дата/напрям/сума/контрагент/призначення/тип, дедуп-хеш, `manual_category` — ручне перенесення), `bank_statements` (залишки `:60F:`/`:62F:` по витягах; `closing_derived` = обчислене закриття, коригується ланцюжком), `expense_categories` (категорії витрат: key/label/pattern-DSL/sort_order; owner-CRUD з веб-панелі), `counterparty_rules` (контрагент→категорія). `companies` має `legal_name`/`nip`/`is_active` (юрособи; TS неактивна)
- **Сводні:** `svodni_rows` (рядки місячної сводної: працівник/місто/фабрика/години/ставки/виплати), `svodni_tab_checks` + `svodni_tab_meta` (звірка й мета вкладок Google-таблиці), `svodni_locks` (локи затвердження: unique period_month+city+factory_label, `''` = ціле місто), `hostel_deductions` (утримання за хостел по місяцях), `worker_changes` (журнал змін профілю з `effective_date`: історія станів людини; куди пропагували/що пропущено через лок; фундамент майбутніх сегментів усередині місяця)
- **Штрафи:** `penalties` (штрафи по місяцях). Поля ставок: `factories.city/rate_brutto/rate_netto/night_addon`, `factory_positions.rate_netto`, `workers.agram_staz_bonus/agram_cash_bonus` (таблиці `svodni2_*` видалені 24.07.2026)
- **Сервісні:** `notifications`, `user_states`, `bot_messages`, `settings`, `admin_sessions` (сесії веб-панелі: `id`=`sid` у токені, `ip`/`user_agent`/`device`/`geo`, `revoked_at` → per-session ревокація), `login_events` (незмінний журнал входів: `event`=success|bad_password|bad_2fa|no_telegram|logout)

Деталі полів — у `lib/db/README.md` та самій схемі. **Зміни — вручну через `psql`** (не drizzle-kit).

---

## Зовнішні інтеграції

| Сервіс | Де | Призначення |
|--------|----|-------------|
| Telegram (Telegraf) | `bot/`, `bot/notify.ts` | бот + усі вихідні сповіщення (polling) |
| Google Sheets | `services/sheets.ts` | доступність працівників (матч за «Прізвище Імʼя») |
| Google Drive | `services/drive.ts` | експорт Excel-графіку (сегрегація посада→стать), звіти |
| Google Drive (витяги) | `services/bankStatements.ts` | читання MT940 з папки `WB {MM.YYYY}/{юрособа}` (service account, `BANK_STATEMENTS_FOLDER_ID`); Kokos — чужий бізнес, пропускається. Чистий шар (кодування/парсер/матчинг юросіб) — `services/mt940.ts`, без БД/Drive, покритий тестами |
| SMTP (nodemailer) | `services/email.ts` | графік клієнту email-ом (тиждень/день, HTML + Excel-вкладення); відправник — Gmail office.eurosupp@gmail.com через app password (`SMTP_*` у `.env`) |
| PostgreSQL | `@workspace/db` | основне сховище |

Доступ Google: Sheets — через `GOOGLE_SERVICE_ACCOUNT_JSON` (таблиця розшарена на service account); **Drive-завантаження — OAuth від реального користувача** (`GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`; перегенерація токена — `artifacts/api-server/get-google-token.mjs`; застосунок має бути **Published**, інакше токен вмирає за 7 днів → `invalid_grant` ламає всі Drive-операції).

---

## Ролі доступу

**Динамічні** — живуть у БД-таблиці `roles` (`pages` jsonb + `caps` jsonb), редагуються головним адміном у Налаштування → «Користувачі та ролі». Каталоги capability/сторінок — `api-server/src/lib/roles.ts` ↔ `web/src/lib/roles.ts` (тримати синхронними). Гейти API: `requireCap`/`requireAnyCap`; capabilities: `editData`, `viewFinance`, `assignDrivers`, `deleteWorkers`, `svodni` (офіційна частина сводних), `svodniSensitive` (закритий шар: księgowość, готівка).

- **owner** — незмінний суперюзер (повний доступ у коді, редагування/видалення ролі заблоковано).
- **scheduler** — системна, редагована (типово editData+assignDrivers, без фінансів).
- **driver** — системна, редагована (типово assignDrivers + водійські сторінки). У **боті** людей з веб-роллю `driver` ведуть як водіїв (`bot/roles.ts` фільтрує їх з адмінів).
- Кастомні ролі — повний CRUD (лише `is_main`).
- **`admins.is_main`** — головний адмін (Yuriy, id=1): **єдиний**, хто керує ролями/користувачами (`requireMainAdmin`). У бота немає шляху видати `is_main`.

---

## Production / deploy flow

> **Джерело правди по продакшн-середовищу — [`docs/infrastructure/`](docs/infrastructure/)**: живий сервер
> ([PRODUCTION.md](docs/infrastructure/PRODUCTION.md)), деплой/відкат ([DEPLOYMENT.md](docs/infrastructure/DEPLOYMENT.md)),
> БД ([DATABASE.md](docs/infrastructure/DATABASE.md)), експлуатація ([RUNBOOK.md](docs/infrastructure/RUNBOOK.md)),
> журнал інцидентів ([INCIDENTS.md](docs/infrastructure/INCIDENTS.md)). Деплой з нуля — [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

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

Довкола деплою:
- **CI** — GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): typecheck + тести api-server на кожен push/PR у `main`.
- **Скіл `/deploy`** ([`.claude/skills/deploy/SKILL.md`](.claude/skills/deploy/SKILL.md)) — виконуваний ранбук деплою для сесій Claude Code.
- **Бекапи** — щодня 03:00 cron → [`deploy/backup.sh`](deploy/backup.sh) → `/root/backups/` (дамп БД + `uploads/`, ротація 14 днів); див. [DATABASE.md](docs/infrastructure/DATABASE.md).

---

## Ризикові місця

- **Подвійний polling бота** → `409 Conflict`. Рівно один `grafik-bot`; не запускати локальний бот на прод-токені.
- **Схема vs psql.** Міграції — SQL-файли в `deploy/migrations/` (`YYYY-MM-DD-тема.sql`), накатуються вручну `psql -f`; авто-запуску немає, тож легко розсинхронити код-схему й реальну БД. Завжди накатуй SQL + `typecheck:libs`. Файли з `CREATE INDEX CONCURRENTLY` не можна запускати однією транзакцією (`psql -1`).
- **Один процес = усе разом.** Падіння кладе і API, і бота, і панель (рятує pm2 autorestart).
- **Tailwind v4** не бачить динамічних класів — лише буквальні (повні класи в `web/src/lib/colors.ts`).
- **i18n-дублі** ключів → TS1117; не забувати EN-переклад + перевірку `uniq -d`.
- **Фінансові поля** мають лишатися owner-only і в API, і в UI.
- **Секрети:** `.env`, `GOOGLE_SERVICE_ACCOUNT_JSON`, SSH-ключ — не комітити/не розкривати. `minimumReleaseAge` у pnpm не вимикати.
- **Google sharing.** Якщо Sheet/Drive не розшарені на service account — доступність/експорт мовчки не працюють.
- **Великі файли:** `bot/index.ts` (~3200) і `routes/admin-api.ts` (~2500) — зміни робити точково, не переписувати масово.
- **Час/зміни** рахуються у Europe/Warsaw — не вводити локальні таймзони у логіку змін. Прод-сервер у Europe/Berlin: `new Date(...).toISOString()` для дати-рядка зрізає день — дати рахувати рядком.
- **Місячні звіти** зараховують зміни за фактичною датою (`entryDateStr`), не за понеділком тижня — тиждень легально перетинає межу місяця.
- **`driver_shift_assignments.kind`:** транспортна логіка (посадка/поїздки/явка) фільтрує `kind='delivery'`; забутий фільтр «дублює» водіїв. Детекція pickup-прогалин продубльована (driver-board + `pickupGaps.ts`) — міняти обидва. **Фабрики без довозу (`uses_transport=false`) виключаються з усіх водійських поверхонь** (driver-board, pickup-прогалини, бот-флоу призначення/огляд тижня, лайв-зміни) — нова водійська поверхня мусить фільтрувати теж.
- **Множина змін поверхні — від записів, не від `shiftCount`.** `factories.shift_count` — лише «стандартний набір» для показу порожньої сітки; запис (`schedule_entries`) на зміні поза лімітом (разова зміна, або лічильник зменшили пізніше) МУСИТЬ лишатися видимим і функціональним. Пуші, `/live`, `/driver-board`, pickup-прогалини, Excel і веб-сітка ітерують «налаштовані ∪ зміни з записами»; час зміни — спершу `factory_shift_overrides` (через `services/shiftOverrides.ts`), потім `factoryShifts()`. Нова поверхня зі змінами — той самий патерн; фільтр `slice(0, shiftCount)` там — регресія (саме він «губив» графік при зміні кількості змін).
- **Статус тижня `approved` ≠ «тиждень у роботі».** Веб працює з draft-тижнями (створює їх при призначенні водіїв наперед); затвердження однієї фабрики ставить approved на весь тиждень. Вибір тижня — тільки `services/weeks.ts` (`resolveWeekRow`/`ensureWeekRow`): водійські поверхні й крон-пуші резолвлять «approved ?? останній draft», approved-only фільтр там — регресія (інцидент 27.07.2026). Робітничі екрани і фінанси/облік — свідомо approved-only.
- **Розсилки реально шлють людям** (`/hours/report-remind`, `/availability/remind`, notify-ендпойнти) — не «тестувати» на проді.
- **Класифікація витягів: bucket-и — в `services/bankClassify.ts` (код), категорії витрат — у БД-таблиці `expense_categories`** (owner редагує на /bank: назви, патерни, додавання/видалення; перший збіг за `sort_order` виграє; кеш у пам'яті інвалідовується мутаціями CRUD). Патерн — міні-DSL (`patternCondition`): рядок = АБО-альтернатива, ` + ` = І, частина = Postgres regex. У Postgres межа слова — `\y`, **не** `\b` (тихо не матчиться); польські відміни (bankomat/bankoma**cie**) — матчити корінь. Видалення категорії переносить її ручні транзакції в `'other'` і зносить її правила контрагентів. Тест-харнес сідить категорії з `DEFAULT_EXPENSE_CATS` після кожного truncate. Кредитний рахунок `PL75…8415` виключений з операційної каси (борг). Нова юрособа/назва підпапки на Drive = правка `matchCompanyName` у `bankStatements.ts`.
- **Enable Banking: повну історію транзакцій банк віддає лише свіжому консенту** (одразу після SCA-авторизації); фонові запити бачать ~2 тижні. Новий консент → одразу запусти синк, не чекай крону, інакше в `bank_transactions` лишиться прогалина, яку MT940 закриє аж наступного місяця, а KSeF/аванси тим часом «не бачать» оплат (інцидент 30.07.2026 — див. `docs/infrastructure/INCIDENTS.md`; бекфіл — перенесення рядків з БД, де історія є, дедуп по `dedup_hash`).
- **`xlsx` (SheetJS) — пін CDN-тарбола `xlsx-0.20.3` (не npm!).** У package.json залежність — URL `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, бо SheetJS публікує фікси лише на своєму CDN (npm застряг на вразливій 0.18.5: prototype pollution CVE-2023-30533 + ReDoS CVE-2024-22363, обидва на `XLSX.read`). **Не «оновлювати» назад на npm-версію** (`^0.18.x`) — це регресія в CVE. `minimumReleaseAge` на URL-тарбол не діє (свідомий виняток, офіційний CDN + точний пін). API той самий; `.xls` (старий бінар) 0.20.x читає. Використання: `XLSX.read` у боті (імпорт графіка/кандидатів, за гейтом `isAdmin`) + `services/drive.ts` (свої файли з Drive), `XLSX.write` — генерація.
